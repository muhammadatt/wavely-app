/**
 * The transport: Play / Stop / skip, and the rules that keep playback in step
 * with the timeline while it runs. Shared by the desktop TransportBar and the
 * mobile shell's transport, so the two cannot play the same file differently.
 *
 * `installTransport()` is called by whichever transport is mounted (one at a
 * time — the shells never mount together): it answers Play / Stop requests
 * from the bus (Space, plugin windows) and watches loop, selection and edits
 * for as long as that component lives.
 */
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { useEditorState } from './useEditorState.js'
import { startPlayback, stopPlayback, setPlaybackLoop, setPlaybackRegion } from '../audio/playback.js'
import { onTogglePlaybackRequest } from '../ui/transportBus.js'

/** Seconds the skip buttons move the playhead. */
export const SKIP_SECONDS = 5

// Whether what is sounding is a selection rather than the whole file. Only
// then does moving the selection mean anything to the transport: with no
// region playing, drawing a selection is the user marking something up, not
// asking playback to jump into it.
const playingRegion = ref(false)

export function useTransport() {
  const { state, setPlayhead, getAudioContext, totalDuration } = useEditorState()

  function play() {
    const ctx = getAudioContext()
    state.isPlaying = true

    let startFrom, endAt
    if (state.selection) {
      startFrom = state.selection.start
      endAt = state.selection.end
    } else {
      startFrom = state.playhead >= totalDuration.value ? 0 : state.playhead
      endAt = null
    }

    playingRegion.value = endAt !== null

    startPlayback(
      state.segments,
      startFrom,
      ctx,
      (time) => { state.playhead = time },
      () => {
        state.isPlaying = false
        playingRegion.value = false
      },
      endAt,
      // Looping is handled inside the engine, on the audio clock. Restarting
      // from here instead could only ever begin the next pass one animation
      // frame after the previous one ended, which is the gap at the seam. A
      // repeat starts where the selection does, or at zero when the whole
      // file is playing: looping a file from the middle should come back to
      // the top, not to wherever playback happened to begin.
      { loop: state.isLooping, loopStart: endAt !== null ? startFrom : 0 },
    )
  }

  function stop() {
    stopPlayback()
    state.isPlaying = false
    playingRegion.value = false
  }

  function togglePlay() {
    if (state.isPlaying) stop()
    else play()
  }

  function skipToStart() {
    if (state.isPlaying) stop()
    setPlayhead(0)
  }

  function skipBack() {
    if (state.isPlaying) stop()
    setPlayhead(Math.max(0, state.playhead - SKIP_SECONDS))
  }

  function skipForward() {
    if (state.isPlaying) stop()
    setPlayhead(Math.min(totalDuration.value, state.playhead + SKIP_SECONDS))
  }

  return { play, stop, togglePlay, skipToStart, skipBack, skipForward }
}

/**
 * Wire the transport to the editor for the calling component's lifetime. Call
 * from the setup of the one transport that is mounted.
 */
export function installTransport() {
  const { state } = useEditorState()
  const { stop, togglePlay } = useTransport()

  // The loop button is live during playback, so the engine has to hear about
  // a toggle mid-pass rather than only at the next play().
  watch(() => state.isLooping, (looping) => {
    if (!state.isPlaying) return
    setPlaybackLoop(looping, state.selection ? state.selection.start : 0)
  })

  // So are the selection's edges. Dragging one while a selection loops has to
  // change what the loop plays now — otherwise auditioning a boundary by ear
  // is a stop/adjust/start cycle for every attempt.
  //
  // A cleared selection is deliberately not a region change: it happens on
  // every click in the waveform, and stopping or re-scoping playback on a
  // stray click would be worse than letting the loop run on.
  watch(() => state.selection, (sel) => {
    if (!state.isPlaying || !playingRegion.value || !sel) return
    setPlaybackRegion(sel.start, sel.end)
  }, { deep: true })

  // Stop playback when segments change (an edit happened during playback).
  watch(() => state.segments, () => {
    if (state.isPlaying) stop()
  }, { deep: true })

  let off = null
  onMounted(() => { off = onTogglePlaybackRequest(togglePlay) })
  onUnmounted(() => off?.())
}
