import { Component, Input, OnInit } from '@angular/core'
import { FormBuilder, FormGroup } from '@angular/forms'
import { NotificationsService } from 'angular2-notifications'
import { UserUpdateMe } from '../../../../../../shared'
import { AuthService } from '../../../core'
import { FormReactive, User, UserService } from '../../../shared'
import { I18n } from '@ngx-translate/i18n-polyfill'

@Component({
  selector: 'my-account-video-settings',
  templateUrl: './my-account-video-settings.component.html',
  styleUrls: [ './my-account-video-settings.component.scss' ]
})
export class MyAccountVideoSettingsComponent extends FormReactive implements OnInit {
  @Input() user: User = null

  form: FormGroup
  formErrors = {}
  validationMessages = {}

  constructor (
    private authService: AuthService,
    private formBuilder: FormBuilder,
    private notificationsService: NotificationsService,
    private userService: UserService,
    private i18n: I18n
  ) {
    super()
  }

  buildForm () {
    this.form = this.formBuilder.group({
      nsfwPolicy: [ this.user.nsfwPolicy ],
      autoPlayVideo: [ this.user.autoPlayVideo ]
    })

    this.form.valueChanges.subscribe(data => this.onValueChanged(data))
  }

  ngOnInit () {
    this.buildForm()
  }

  updateDetails () {
    const nsfwPolicy = this.form.value['nsfwPolicy']
    const autoPlayVideo = this.form.value['autoPlayVideo']
    const details: UserUpdateMe = {
      nsfwPolicy,
      autoPlayVideo
    }

    this.userService.updateMyProfile(details).subscribe(
      () => {
        this.notificationsService.success(this.i18n('Success'), this.i18n('Information updated.'))

        this.authService.refreshUserInformation()
      },

      err => this.notificationsService.error(this.i18n('Error'), err.message)
    )
  }
}
