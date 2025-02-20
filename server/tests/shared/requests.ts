import { doRequest } from '@server/helpers/requests'
import { activityPubContextify } from '@server/helpers/activitypub'
import { HTTP_SIGNATURE } from '@server/initializers/constants'
import { buildGlobalHeaders } from '@server/lib/job-queue/handlers/utils/activitypub-http-utils'

export function makePOSTAPRequest (url: string, body: any, httpSignature: any, headers: any) {
  const options = {
    method: 'POST' as 'POST',
    json: body,
    httpSignature,
    headers
  }

  return doRequest(url, options)
}

export async function makeFollowRequest (to: { url: string }, by: { url: string, privateKey }) {
  const follow = {
    type: 'Follow',
    id: by.url + '/' + new Date().getTime(),
    actor: by.url,
    object: to.url
  }

  const body = activityPubContextify(follow)

  const httpSignature = {
    algorithm: HTTP_SIGNATURE.ALGORITHM,
    authorizationHeaderName: HTTP_SIGNATURE.HEADER_NAME,
    keyId: by.url,
    key: by.privateKey,
    headers: HTTP_SIGNATURE.HEADERS_TO_SIGN
  }
  const headers = buildGlobalHeaders(body)

  return makePOSTAPRequest(to.url + '/inbox', body, httpSignature, headers)
}
