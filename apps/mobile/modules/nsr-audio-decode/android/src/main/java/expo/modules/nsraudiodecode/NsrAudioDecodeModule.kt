package expo.modules.nsraudiodecode

import android.content.Intent
import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.floor

/**
 * 녹음 파일(m4a 등)을 whisper.cpp 가 읽는 16kHz 모노 PCM16 WAV 로 바꾼다.
 *
 * 왜 필요한가: 안드로이드 MediaRecorder 는 WAV 를 못 만들고(AAC 계열만),
 * whisper.rn 의 파일 전사는 WAV 만 읽는다. 그 사이를 OS 코덱(MediaCodec)으로
 * 잇는다 — 외부 라이브러리 없이 폰에 이미 있는 디코더를 쓴다.
 */
class NsrAudioDecodeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("NsrAudioDecode")

    // 30분 조각 기준 수 초~수십 초짜리 CPU 작업. 전사 직전에만 부른다.
    AsyncFunction("decodeToWav16k") { srcPath: String, dstPath: String ->
      decode(srcPath, dstPath)
    }

    // 파일 길이(초). 못 읽으면 0.
    AsyncFunction("audioDurationSec") { srcPath: String ->
      durationSec(srcPath)
    }

    // 긴 파일을 조각으로. 빈 목록이면 안 나눠도 된다는 뜻이다.
    AsyncFunction("splitAudio") { srcPath: String, dstDir: String, chunkSec: Double ->
      split(srcPath, dstDir, chunkSec)
    }

    // ── 작업 유지 (포그라운드 서비스) ───────────────────────
    // 다운로드·전사 동안 붙잡아 두면 다른 앱으로 넘어가도
    // 얼리기(app freezer)·네트워크 차단에서 면제된다.
    // 시작은 사용자가 버튼을 누른 포그라운드 시점이라 인텐트로,
    // 갱신·중지는 백그라운드에서도 안전하도록 인스턴스 직접 호출로.
    Function("workStart") { title: String, body: String ->
      val context = appContext.reactContext ?: return@Function
      val running = NsrWorkService.instance
      if (running != null) {
        running.updateWork(title, body)
        return@Function
      }
      val intent = Intent(context, NsrWorkService::class.java)
        .setAction(NsrWorkService.ACTION_START)
        .putExtra(NsrWorkService.EXTRA_TITLE, title)
        .putExtra(NsrWorkService.EXTRA_BODY, body)
      ContextCompat.startForegroundService(context, intent)
    }
    Function("workUpdate") { title: String, body: String ->
      NsrWorkService.instance?.updateWork(title, body)
    }
    Function("workStop") {
      NsrWorkService.instance?.stopWork()
    }
  }
}

private const val DST_RATE = 16000
private const val TIMEOUT_US = 10_000L

/** 선형 보간 리샘플러. 버퍼 경계를 넘어도 이어지도록 마지막 표본을 기억한다. */
// ponytail: 저역필터 없는 선형 보간 — 음성 전사에는 충분하고, 부족해지면 평균 필터를 앞에 단다.
private class MonoResampler(private val srcRate: Int) {
  private var last = 0
  private var haveLast = false
  private var pos = 0.0
  private var consumed = 0L
  private val step = srcRate.toDouble() / DST_RATE

  fun process(input: ShortArray, n: Int, out: (Short) -> Unit) {
    if (srcRate == DST_RATE) {
      for (i in 0 until n) out(input[i])
      consumed += n
      return
    }
    while (true) {
      val i0 = floor(pos).toLong()
      if (i0 + 1 >= consumed + n) break
      val frac = pos - i0
      val s0 = if (i0 < consumed) (if (haveLast) last else 0) else input[(i0 - consumed).toInt()].toInt()
      val s1 = input[(i0 + 1 - consumed).toInt()].toInt()
      out((s0 + (s1 - s0) * frac).toInt().coerceIn(-32768, 32767).toShort())
      pos += step
    }
    if (n > 0) {
      last = input[n - 1].toInt()
      haveLast = true
    }
    consumed += n
  }
}

private fun decode(srcPath: String, dstPath: String): String {
  val extractor = MediaExtractor()
  extractor.setDataSource(srcPath)
  var track = -1
  var format: MediaFormat? = null
  for (i in 0 until extractor.trackCount) {
    val f = extractor.getTrackFormat(i)
    if ((f.getString(MediaFormat.KEY_MIME) ?: "").startsWith("audio/")) {
      track = i
      format = f
      break
    }
  }
  if (track < 0 || format == null) {
    extractor.release()
    throw IllegalArgumentException("오디오 트랙이 없는 파일입니다: $srcPath")
  }
  extractor.selectTrack(track)

  val mime = format.getString(MediaFormat.KEY_MIME)!!
  val codec = MediaCodec.createDecoderByType(mime)
  codec.configure(format, null, null, 0)
  codec.start()

  var srcRate = if (format.containsKey(MediaFormat.KEY_SAMPLE_RATE)) format.getInteger(MediaFormat.KEY_SAMPLE_RATE) else 44100
  var channels = if (format.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) format.getInteger(MediaFormat.KEY_CHANNEL_COUNT) else 1
  var resampler = MonoResampler(srcRate)

  val dst = File(dstPath)
  dst.parentFile?.mkdirs()
  val outStream = BufferedOutputStream(FileOutputStream(dst), 1 shl 16)
  outStream.write(ByteArray(44)) // WAV 헤더 자리. 크기를 알게 되는 마지막에 채운다.
  var dataBytes = 0L
  val two = ByteArray(2)
  val writeSample: (Short) -> Unit = { s ->
    two[0] = (s.toInt() and 0xFF).toByte()
    two[1] = ((s.toInt() shr 8) and 0xFF).toByte()
    outStream.write(two)
    dataBytes += 2
  }

  val info = MediaCodec.BufferInfo()
  var inputDone = false
  var outputDone = false
  var stall = 0
  var mono = ShortArray(0)

  try {
    while (!outputDone) {
      var progressed = false
      if (!inputDone) {
        val inIx = codec.dequeueInputBuffer(TIMEOUT_US)
        if (inIx >= 0) {
          progressed = true
          val buf = codec.getInputBuffer(inIx)!!
          val n = extractor.readSampleData(buf, 0)
          if (n < 0) {
            codec.queueInputBuffer(inIx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
            inputDone = true
          } else {
            codec.queueInputBuffer(inIx, 0, n, extractor.sampleTime, 0)
            extractor.advance()
          }
        }
      }

      val outIx = codec.dequeueOutputBuffer(info, TIMEOUT_US)
      when {
        outIx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
          progressed = true
          val f = codec.outputFormat
          val enc = if (f.containsKey(MediaFormat.KEY_PCM_ENCODING)) f.getInteger(MediaFormat.KEY_PCM_ENCODING) else AudioFormat.ENCODING_PCM_16BIT
          if (enc != AudioFormat.ENCODING_PCM_16BIT) {
            throw IllegalStateException("이 기기의 디코더가 16비트 PCM 을 내놓지 않습니다 (encoding=$enc)")
          }
          val newRate = f.getInteger(MediaFormat.KEY_SAMPLE_RATE)
          channels = f.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
          if (newRate != srcRate) {
            srcRate = newRate
            resampler = MonoResampler(srcRate)
          }
        }
        outIx >= 0 -> {
          progressed = true
          if (info.size > 0) {
            val buf = codec.getOutputBuffer(outIx)!!
            buf.position(info.offset)
            buf.limit(info.offset + info.size)
            val shorts: ByteBuffer = buf.order(ByteOrder.LITTLE_ENDIAN)
            val frames = info.size / 2 / channels
            if (mono.size < frames) mono = ShortArray(frames)
            for (fIx in 0 until frames) {
              var acc = 0
              for (c in 0 until channels) acc += shorts.getShort((info.offset + (fIx * channels + c) * 2)).toInt()
              mono[fIx] = (acc / channels).toShort()
            }
            resampler.process(mono, frames, writeSample)
          }
          codec.releaseOutputBuffer(outIx, false)
          if ((info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) outputDone = true
        }
      }

      stall = if (progressed) 0 else stall + 1
      if (stall > 500) throw IllegalStateException("디코더가 멈췄습니다 (10초 이상 무응답)")
    }
  } finally {
    runCatching { codec.stop() }
    codec.release()
    extractor.release()
    outStream.flush()
    outStream.close()
  }

  if (dataBytes == 0L) {
    dst.delete()
    throw IllegalStateException("디코딩 결과가 비어 있습니다: $srcPath")
  }

  RandomAccessFile(dst, "rw").use { raf ->
    val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
    header.put("RIFF".toByteArray())
    header.putInt((36 + dataBytes).toInt())
    header.put("WAVE".toByteArray())
    header.put("fmt ".toByteArray())
    header.putInt(16)
    header.putShort(1.toShort()) // PCM
    header.putShort(1.toShort()) // mono
    header.putInt(DST_RATE)
    header.putInt(DST_RATE * 2) // byte rate
    header.putShort(2.toShort()) // block align
    header.putShort(16.toShort()) // bits
    header.put("data".toByteArray())
    header.putInt(dataBytes.toInt())
    raf.seek(0)
    raf.write(header.array())
  }
  return dstPath
}

// ── 파일 나누기 ────────────────────────────────────────────
//
// 티로는 한 파일에 5시간까지만 받는다. 8~12시간짜리 통짜 녹음을 가져오면
// 통째로는 못 보낸다. 그래서 **다시 인코딩하지 않고** 컨테이너만 새로 써서
// 3시간 조각으로 나눈다 (MediaExtractor 로 압축된 프레임을 그대로 읽어
// MediaMuxer 로 옮겨 담는다). 음질은 원본 그대로고, 3시간 파일이 몇 초 만에
// 나뉜다 — 디코딩(decodeToWav16k)과 달리 CPU 를 거의 안 쓴다.

/** MPEG-4 컨테이너가 담을 수 있는 오디오 코덱. 그 밖(mp3 등)은 못 나눈다. */
private fun muxable(mime: String): Boolean =
  mime == "audio/mp4a-latm" || mime == "audio/3gpp" || mime == "audio/amr-wb"

private fun audioTrackOf(extractor: MediaExtractor): Pair<Int, MediaFormat>? {
  for (i in 0 until extractor.trackCount) {
    val f = extractor.getTrackFormat(i)
    if ((f.getString(MediaFormat.KEY_MIME) ?: "").startsWith("audio/")) return i to f
  }
  return null
}

/** 길이(초). 못 읽으면 0 — 부르는 쪽에서 '모른다'로 본다. */
private fun durationSec(srcPath: String): Double {
  val extractor = MediaExtractor()
  try {
    extractor.setDataSource(srcPath)
    val (_, format) = audioTrackOf(extractor) ?: return 0.0
    if (!format.containsKey(MediaFormat.KEY_DURATION)) return 0.0
    return format.getLong(MediaFormat.KEY_DURATION) / 1_000_000.0
  } finally {
    runCatching { extractor.release() }
  }
}

/**
 * chunkSec 초씩 잘라 dstDir 에 m4a 조각을 만든다.
 *
 * 돌려주는 값은 조각마다 `{ path, startSec, durationSec }`.
 * **빈 목록은 "안 나눠도 된다"** 는 뜻이다 — 파일이 짧거나, 담을 수 없는
 * 코덱이거나(mp3 등), 조각이 하나뿐일 때. 부르는 쪽은 원본을 그대로 쓴다.
 */
private fun split(srcPath: String, dstDir: String, chunkSec: Double): List<Map<String, Any>> {
  val chunkUs = (chunkSec * 1_000_000.0).toLong()
  if (chunkUs <= 0) return emptyList()

  val extractor = MediaExtractor()
  extractor.setDataSource(srcPath)
  val found = audioTrackOf(extractor)
  if (found == null) {
    extractor.release()
    throw IllegalArgumentException("오디오 트랙이 없는 파일입니다: $srcPath")
  }
  val (track, format) = found
  val mime = format.getString(MediaFormat.KEY_MIME) ?: ""
  val knownUs = if (format.containsKey(MediaFormat.KEY_DURATION)) format.getLong(MediaFormat.KEY_DURATION) else -1L
  if (!muxable(mime) || (knownUs in 1..chunkUs)) {
    extractor.release()
    return emptyList()
  }
  extractor.selectTrack(track)

  // 한 프레임이 들어갈 만큼. 적으면 readSampleData 가 거절하니 넉넉히 잡는다.
  val maxInput = if (format.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) {
    format.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE).coerceAtLeast(1 shl 19)
  } else {
    1 shl 20
  }
  val buffer = ByteBuffer.allocate(maxInput)
  val info = MediaCodec.BufferInfo()

  val dir = File(dstDir)
  dir.mkdirs()
  val parts = mutableListOf<Map<String, Any>>()
  val written = mutableListOf<File>()
  var muxer: MediaMuxer? = null
  var outTrack = -1
  var partStartUs = 0L
  var lastUs = 0L

  fun closePart() {
    val m = muxer ?: return
    runCatching { m.stop() }
    runCatching { m.release() }
    muxer = null
    val file = written.last()
    parts.add(
      mapOf(
        "path" to file.absolutePath,
        "startSec" to partStartUs / 1_000_000.0,
        "durationSec" to (lastUs - partStartUs) / 1_000_000.0,
      ),
    )
  }

  try {
    while (true) {
      val n = extractor.readSampleData(buffer, 0)
      if (n < 0) break
      val t = extractor.sampleTime
      if (muxer != null && t - partStartUs >= chunkUs) closePart()
      if (muxer == null) {
        val file = File(dir, "part-%02d.m4a".format(parts.size + 1))
        written.add(file)
        val m = MediaMuxer(file.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
        outTrack = m.addTrack(format)
        m.start()
        muxer = m
        partStartUs = t
      }
      info.offset = 0
      info.size = n
      info.presentationTimeUs = t - partStartUs
      info.flags = if ((extractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC) != 0) {
        MediaCodec.BUFFER_FLAG_KEY_FRAME
      } else {
        0
      }
      muxer!!.writeSampleData(outTrack, buffer, info)
      lastUs = t
      extractor.advance()
    }
    closePart()
  } catch (e: Throwable) {
    runCatching { muxer?.release() }
    written.forEach { runCatching { it.delete() } }
    throw e
  } finally {
    runCatching { extractor.release() }
  }

  // 조각이 하나면 나눈 보람이 없다 — 원본을 쓰게 두고 복사본은 지운다.
  if (parts.size <= 1) {
    written.forEach { runCatching { it.delete() } }
    return emptyList()
  }
  return parts
}
