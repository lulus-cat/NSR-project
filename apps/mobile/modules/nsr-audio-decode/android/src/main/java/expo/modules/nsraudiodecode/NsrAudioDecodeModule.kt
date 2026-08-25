package expo.modules.nsraudiodecode

import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
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
