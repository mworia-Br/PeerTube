import express from 'express'
import { Transaction } from 'sequelize/types'
import { updateTorrentMetadata } from '@server/helpers/webtorrent'
import { changeVideoChannelShare } from '@server/lib/activitypub/share'
import { buildVideoThumbnailsFromReq, setVideoTags } from '@server/lib/video'
import { openapiOperationDoc } from '@server/middlewares/doc'
import { FilteredModelAttributes } from '@server/types'
import { MVideoFullLight } from '@server/types/models'
import { VideoUpdate } from '../../../../shared'
import { HttpStatusCode } from '../../../../shared/models'
import { auditLoggerFactory, getAuditIdFromRes, VideoAuditView } from '../../../helpers/audit-logger'
import { resetSequelizeInstance } from '../../../helpers/database-utils'
import { createReqFiles } from '../../../helpers/express-utils'
import { logger, loggerTagsFactory } from '../../../helpers/logger'
import { CONFIG } from '../../../initializers/config'
import { MIMETYPES } from '../../../initializers/constants'
import { sequelizeTypescript } from '../../../initializers/database'
import { federateVideoIfNeeded } from '../../../lib/activitypub/videos'
import { Notifier } from '../../../lib/notifier'
import { Hooks } from '../../../lib/plugins/hooks'
import { autoBlacklistVideoIfNeeded } from '../../../lib/video-blacklist'
import { asyncMiddleware, asyncRetryTransactionMiddleware, authenticate, videosUpdateValidator } from '../../../middlewares'
import { ScheduleVideoUpdateModel } from '../../../models/video/schedule-video-update'
import { VideoModel } from '../../../models/video/video'

const lTags = loggerTagsFactory('api', 'video')
const auditLogger = auditLoggerFactory('videos')
const updateRouter = express.Router()

const reqVideoFileUpdate = createReqFiles(
  [ 'thumbnailfile', 'previewfile' ],
  MIMETYPES.IMAGE.MIMETYPE_EXT,
  {
    thumbnailfile: CONFIG.STORAGE.TMP_DIR,
    previewfile: CONFIG.STORAGE.TMP_DIR
  }
)

updateRouter.put('/:id',
  openapiOperationDoc({ operationId: 'putVideo' }),
  authenticate,
  reqVideoFileUpdate,
  asyncMiddleware(videosUpdateValidator),
  asyncRetryTransactionMiddleware(updateVideo)
)

// ---------------------------------------------------------------------------

export {
  updateRouter
}

// ---------------------------------------------------------------------------

async function updateVideo (req: express.Request, res: express.Response) {
  const videoFromReq = res.locals.videoAll
  const videoFieldsSave = videoFromReq.toJSON()
  const oldVideoAuditView = new VideoAuditView(videoFromReq.toFormattedDetailsJSON())
  const videoInfoToUpdate: VideoUpdate = req.body

  const wasConfidentialVideo = videoFromReq.isConfidential()
  const hadPrivacyForFederation = videoFromReq.hasPrivacyForFederation()

  const [ thumbnailModel, previewModel ] = await buildVideoThumbnailsFromReq({
    video: videoFromReq,
    files: req.files,
    fallback: () => Promise.resolve(undefined),
    automaticallyGenerated: false
  })

  try {
    const { videoInstanceUpdated, isNewVideo } = await sequelizeTypescript.transaction(async t => {
      // Refresh video since thumbnails to prevent concurrent updates
      const video = await VideoModel.loadAndPopulateAccountAndServerAndTags(videoFromReq.id, t)

      const sequelizeOptions = { transaction: t }
      const oldVideoChannel = video.VideoChannel

      const keysToUpdate: (keyof VideoUpdate & FilteredModelAttributes<VideoModel>)[] = [
        'name',
        'category',
        'licence',
        'language',
        'nsfw',
        'waitTranscoding',
        'support',
        'description',
        'commentsEnabled',
        'downloadEnabled'
      ]

      for (const key of keysToUpdate) {
        if (videoInfoToUpdate[key] !== undefined) video.set(key, videoInfoToUpdate[key])
      }

      if (videoInfoToUpdate.originallyPublishedAt !== undefined && videoInfoToUpdate.originallyPublishedAt !== null) {
        video.originallyPublishedAt = new Date(videoInfoToUpdate.originallyPublishedAt)
      }

      // Privacy update?
      let isNewVideo = false
      if (videoInfoToUpdate.privacy !== undefined) {
        isNewVideo = await updateVideoPrivacy({ videoInstance: video, videoInfoToUpdate, hadPrivacyForFederation, transaction: t })
      }

      // Force updatedAt attribute change
      if (!video.changed()) {
        await video.setAsRefreshed(t)
      }

      const videoInstanceUpdated = await video.save(sequelizeOptions) as MVideoFullLight

      // Thumbnail & preview updates?
      if (thumbnailModel) await videoInstanceUpdated.addAndSaveThumbnail(thumbnailModel, t)
      if (previewModel) await videoInstanceUpdated.addAndSaveThumbnail(previewModel, t)

      // Video tags update?
      if (videoInfoToUpdate.tags !== undefined) {
        await setVideoTags({ video: videoInstanceUpdated, tags: videoInfoToUpdate.tags, transaction: t })
      }

      // Video channel update?
      if (res.locals.videoChannel && videoInstanceUpdated.channelId !== res.locals.videoChannel.id) {
        await videoInstanceUpdated.$set('VideoChannel', res.locals.videoChannel, { transaction: t })
        videoInstanceUpdated.VideoChannel = res.locals.videoChannel

        if (hadPrivacyForFederation === true) await changeVideoChannelShare(videoInstanceUpdated, oldVideoChannel, t)
      }

      // Schedule an update in the future?
      await updateSchedule(videoInstanceUpdated, videoInfoToUpdate, t)

      await autoBlacklistVideoIfNeeded({
        video: videoInstanceUpdated,
        user: res.locals.oauth.token.User,
        isRemote: false,
        isNew: false,
        transaction: t
      })

      auditLogger.update(
        getAuditIdFromRes(res),
        new VideoAuditView(videoInstanceUpdated.toFormattedDetailsJSON()),
        oldVideoAuditView
      )
      logger.info('Video with name %s and uuid %s updated.', video.name, video.uuid, lTags(video.uuid))

      return { videoInstanceUpdated, isNewVideo }
    })

    if (videoInfoToUpdate.name) await updateTorrentsMetadata(videoInstanceUpdated)

    await sequelizeTypescript.transaction(t => federateVideoIfNeeded(videoInstanceUpdated, isNewVideo, t))

    if (wasConfidentialVideo) Notifier.Instance.notifyOnNewVideoIfNeeded(videoInstanceUpdated)

    Hooks.runAction('action:api.video.updated', { video: videoInstanceUpdated, body: req.body, req, res })
  } catch (err) {
    // Force fields we want to update
    // If the transaction is retried, sequelize will think the object has not changed
    // So it will skip the SQL request, even if the last one was ROLLBACKed!
    resetSequelizeInstance(videoFromReq, videoFieldsSave)

    throw err
  }

  return res.type('json')
            .status(HttpStatusCode.NO_CONTENT_204)
            .end()
}

async function updateVideoPrivacy (options: {
  videoInstance: MVideoFullLight
  videoInfoToUpdate: VideoUpdate
  hadPrivacyForFederation: boolean
  transaction: Transaction
}) {
  const { videoInstance, videoInfoToUpdate, hadPrivacyForFederation, transaction } = options
  const isNewVideo = videoInstance.isNewVideo(videoInfoToUpdate.privacy)

  const newPrivacy = parseInt(videoInfoToUpdate.privacy.toString(), 10)
  videoInstance.setPrivacy(newPrivacy)

  // Unfederate the video if the new privacy is not compatible with federation
  if (hadPrivacyForFederation && !videoInstance.hasPrivacyForFederation()) {
    await VideoModel.sendDelete(videoInstance, { transaction })
  }

  return isNewVideo
}

function updateSchedule (videoInstance: MVideoFullLight, videoInfoToUpdate: VideoUpdate, transaction: Transaction) {
  if (videoInfoToUpdate.scheduleUpdate) {
    return ScheduleVideoUpdateModel.upsert({
      videoId: videoInstance.id,
      updateAt: new Date(videoInfoToUpdate.scheduleUpdate.updateAt),
      privacy: videoInfoToUpdate.scheduleUpdate.privacy || null
    }, { transaction })
  } else if (videoInfoToUpdate.scheduleUpdate === null) {
    return ScheduleVideoUpdateModel.deleteByVideoId(videoInstance.id, transaction)
  }
}

async function updateTorrentsMetadata (video: MVideoFullLight) {
  for (const file of (video.VideoFiles || [])) {
    await updateTorrentMetadata(video, file)

    await file.save()
  }

  const hls = video.getHLSPlaylist()
  if (!hls) return

  for (const file of (hls.VideoFiles || [])) {
    await updateTorrentMetadata(hls, file)

    await file.save()
  }
}
