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
    ensureChannel()
    val notification = build(title, body)
    if (Build.VERSION.SDK_INT >= 29) {
      // 녹음 중에는 microphone 유형이 있어야 화면을 꺼도 마이크가 살아 있다
      // (안드로이드 14+). 그 유형은 RECORD_AUDIO 를 받은 뒤에만 쓸 수 있으므로
      // 녹음이 아닌 작업(내려받기)에는 dataSync 만 준다 — 아니면 SecurityException.
      val type =
        if (mic) {
          ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC or
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        } else {
          ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
        }
      startForeground(NOTIF_ID, notification, type)
    } else {
      startForeground(NOTIF_ID, notification)
    }
    acquireWakeLock()
    return START_NOT_STICKY
  }

  /** 진행 알림 갱신. 포그라운드 상태는 건드리지 않는다. */
  fun updateWork(title: String, body: String) {
    ensureChannel()
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    manager.notify(NOTIF_ID, build(title, body))
  }

  /** 작업 종료 — 알림을 내리고 서비스를 끝낸다. */
  fun stopWork() {
    releaseWakeLock()
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
      acquire(6 * 3600 * 1000L)
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
