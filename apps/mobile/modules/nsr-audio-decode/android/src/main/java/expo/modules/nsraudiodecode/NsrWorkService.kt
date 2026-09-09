package expo.modules.nsraudiodecode

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * 작업 유지용 포그라운드 서비스.
 *
 * 왜 필요한가: 다른 앱으로 넘어가면 Android 가 우리 프로세스를 얼린다
 * (cached app freezer). 받던 소켓은 "Software caused connection abort"로
 * 끊기고 전사 스레드도 멈춘다 — 실기기에서 그대로 재현됐다.
 * 포그라운드 서비스를 잡고 있는 동안은 얼리기·네트워크 차단에서 면제된다.
 *
 * 알림이 곧 진행 표시다: 시작·갱신 인텐트의 제목/본문으로 같은 알림을
 * 계속 덮어쓴다. dataSync 유형이라 Android 14+ 에서 한 번에 최대 6시간 —
 * 전사·다운로드에는 넉넉하다.
 */
class NsrWorkService : Service() {
  companion object {
    const val ACTION_START = "start"
    const val EXTRA_TITLE = "title"
    const val EXTRA_BODY = "body"
    /** 참이면 마이크 유형까지 잡는다 (녹음 중). */
    const val EXTRA_MIC = "mic"
    private const val NOTIF_ID = 41100
    private const val CHANNEL_ID = "nsr-work"

    /**
     * 갱신·중지는 인텐트가 아니라 이 참조로 직접 부른다.
     * 앱이 백그라운드일 때 startForegroundService 를 다시 부르는 것은
     * Android 12+ 가 막는데, 진행 갱신은 대부분 백그라운드에서 일어난다.
     */
    @Volatile var instance: NsrWorkService? = null
    /** 지금 마이크 유형까지 잡고 있는가. 한 번 잡으면 내려가지 않는다. */
    @Volatile var hasMic = false
  }

  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    instance = this
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val title = intent?.getStringExtra(EXTRA_TITLE) ?: "작업 진행 중"
    val body = intent?.getStringExtra(EXTRA_BODY) ?: ""
    val mic = intent?.getBooleanExtra(EXTRA_MIC, false) ?: false
    goForeground(title, body, mic)
    acquireWakeLock()
    return START_NOT_STICKY
  }

  /**
   * 알림 갱신. `mic` 가 참인데 아직 마이크 유형이 아니면 **유형을 올린다.**
   *
   * 이게 없으면 이런 일이 난다: 아침에 티로 노트를 가져오느라 서비스가
   * dataSync 로 떠 있고, 그 상태에서 근무 기록이 시작되면 유형이 그대로라
   * 화면을 끄는 순간 안드로이드 14+ 가 마이크를 끊는다. 사용자에게는
   * "기록 중" 알림만 보인다.
   */
  fun updateWork(title: String, body: String, mic: Boolean = false) {
    if (mic && !hasMic) {
      goForeground(title, body, true)
      return
    }
    ensureChannel()
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    manager.notify(NOTIF_ID, build(title, body))
  }

  /**
   * 포그라운드로 올린다(또는 유형을 바꾼다).
   *
   * 녹음일 때는 **microphone 만** 쓴다. dataSync 를 함께 주면 안드로이드 14+ 의
   * dataSync 시간 제한(24시간에 6시간)이 이 서비스에도 걸려서, 8~12시간 근무
   * 도중에 시스템이 서비스를 끝내 버린다. microphone 에는 그 제한이 없다.
   */
  private fun goForeground(title: String, body: String, mic: Boolean) {
    ensureChannel()
    val notification = build(title, body)
    try {
      if (Build.VERSION.SDK_INT >= 29) {
        val type =
          if (mic) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
          else ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
        startForeground(NOTIF_ID, notification, type)
      } else {
        startForeground(NOTIF_ID, notification)
      }
      if (mic) hasMic = true
    } catch (e: Throwable) {
      // 안드로이드 14 는 앱이 뒤에 있을 때 마이크 유형을 거부한다(SecurityException).
      // 여기서 던지면 서비스가 아니라 **앱이 통째로** 죽는다. 조용히 내려가고,
      // JS 쪽은 마이크 감시가 몇 분 안에 알아챈다.
      android.util.Log.w("NsrWorkService", "startForeground 거부: ${e.javaClass.simpleName}")
      instance = null
      stopSelf()
    }
  }

  /** 작업 종료 — 알림을 내리고 서비스를 끝낸다. */
  fun stopWork() {
    releaseWakeLock()
    // instance 를 **여기서** 비운다. onDestroy 까지 기다리면, 곧바로 이어지는
    // 재시작이 죽어 가는 인스턴스를 보고 "이미 떠 있네" 하며 알림만 갱신한다 —
    // 그 결과 되살린 기록에는 포그라운드 서비스가 아예 없다.
    instance = null
    hasMic = false
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  override fun onDestroy() {
    instance = null
    releaseWakeLock()
    super.onDestroy()
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < 26) return
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    val channel = NotificationChannel(CHANNEL_ID, "작업 진행", NotificationManager.IMPORTANCE_LOW)
    channel.setSound(null, null)
    channel.enableVibration(false)
    manager.createNotificationChannel(channel)
  }

  private fun build(title: String, body: String): Notification {
    val builder =
      if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL_ID)
      else @Suppress("DEPRECATION") Notification.Builder(this)
    return builder
      .setContentTitle(title)
      .setContentText(body)
      .setSmallIcon(applicationInfo.icon)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .build()
  }

  private fun acquireWakeLock() {
    if (wakeLock?.isHeld == true) return
    val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "nsr:work").apply {
      setReferenceCounted(false)
      // 안전핀: 작업이 끝맺음을 놓쳐도 6시간이면 스스로 풀린다.
      // 근무는 8~12시간이다. 6시간에 놓으면 후반이 통째로 잠금 없이 돈다.
      acquire(13 * 3600 * 1000L)
    }
  }

  private fun releaseWakeLock() {
    try {
      if (wakeLock?.isHeld == true) wakeLock?.release()
    } catch (_: Throwable) {
      // 이미 풀렸으면 그만이다.
    }
    wakeLock = null
  }
}
