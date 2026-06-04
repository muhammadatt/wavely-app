/**
 * Audio Effect Presets and Output Profiles
 *
 * Pure data definitions for the Instant Polish processing chain.
 * No side effects, no Vue dependency.
 */

/**
 * @typedef {Object} OutputProfile
 * @property {string} id
 * @property {string} displayName
 * @property {[number, number]} loudnessRange - [min, max] in dBFS (RMS) or LUFS — defines the acceptable compliance window
 * @property {number} normalizationTarget - the specific dBFS RMS or LUFS value to target during normalization (may differ from loudnessRange midpoint)
 * @property {number} truePeakCeiling - dBFS
 * @property {number|null} noiseFloorCeiling - dBFS, null if not enforced
 * @property {'RMS'|'LUFS'} measurementMethod
 */

/** @type {Record<string, OutputProfile>} */
export const OUTPUT_PROFILES = {
  acx: {
    id: "acx",
    displayName: "ACX Audiobook",
    loudnessRange: [-23, -18],
    normalizationTarget: -20, // dBFS RMS — ACX spec target, not the range midpoint (-20.5)
    truePeakCeiling: -3,
    noiseFloorCeiling: -60,
    measurementMethod: "RMS",
  },
  podcast: {
    id: "podcast",
    displayName: "Podcast / Streaming",
    loudnessRange: [-18, -14],
    normalizationTarget: -16, // LUFS integrated — midpoint of loudnessRange
    truePeakCeiling: -1,
    noiseFloorCeiling: null,
    measurementMethod: "LUFS",
  },
  broadcast: {
    id: "broadcast",
    displayName: "Broadcast",
    loudnessRange: [-24, -22],
    normalizationTarget: -23, // LUFS integrated — midpoint of loudnessRange
    truePeakCeiling: -1,
    noiseFloorCeiling: null,
    measurementMethod: "LUFS",
  },
}

// Backward compatibility: accept 'standard' as alias for 'podcast'
export function resolveOutputProfileId(id) {
  if (id === "standard") return "podcast"
  return id
}

/**
 * @typedef {Object} ParallelCompressionConfig
 * @property {number} ratio                        - Wet branch compressor ratio (e.g. 8 for 8:1)
 * @property {number} attackMs                     - Attack time in ms
 * @property {number} releaseMs                    - Release time in ms
 * @property {number|'auto'} makeupGain            - Makeup gain: number for fixed dB, 'auto' for automatic matching
 * @property {number} wetMix                       - Target wet mix fraction (0.0–1.0)
 * @property {number} vadFadeMs                    - VAD gate fade duration (ms) for open and close transitions
 * @property {number} crestGuardThresholdDb        - Crest factor below which wet mix is scaled down
 * @property {WetBranchDeEsserConfig} [wetBranchDeEsser]
 *                                                 - Wet-branch de-esser settings. When
 *                                                   present (and the upstream
 *                                                   `clipGainDeEsser` stage emitted an
 *                                                   events.json), a second clip-gain
 *                                                   decision pass runs against the
 *                                                   synthesized wet branch (compressed
 *                                                   + makeup-gained), reusing those event
 *                                                   boundaries but re-measuring peak and
 *                                                   context RMS on the wet signal. The
 *                                                   resulting envelope is applied to the
 *                                                   wet branch only — letting aggressive
 *                                                   wet-side attenuation "hide" the
 *                                                   compressed sibilant so the dry
 *                                                   sibilant character predominates at
 *                                                   the mix output. Independent from the
 *                                                   dry-path `clipGainDeEsser` config.
 * @property {boolean} [bypassVadGate]             - Debug escape: when true, the wet branch
 *                                                   VAD gate is skipped (gate curve forced to
 *                                                   1.0 everywhere). Only useful for soloing
 *                                                   the wet branch at high wetMix values —
 *                                                   leaves the makeup-gained noise floor
 *                                                   audible during silence in normal use.
 *
 * @typedef {Object} WetBranchDeEsserConfig
 * @property {boolean} [enabled]           - Explicit kill switch (default true when
 *                                           the block is present). Set to false to
 *                                           disable the wet-branch de-esser pass
 *                                           without removing the block — useful for
 *                                           A/B comparisons against the dry-only
 *                                           sibilant path. When false the wet branch
 *                                           passes through with no sibilant
 *                                           attenuation; all other knobs in this
 *                                           block are ignored.
 * @property {number} [stridentCeilingDb]
 *                                         - dB above surrounding voiced RMS at which an
 *                                           event tagged sibilantClass = "strident"
 *                                           (/s/, /ʃ/) must sit before attenuation is
 *                                           applied. Strident events naturally project
 *                                           above the surrounding RMS, so this stays
 *                                           positive even on the wet branch.
 * @property {number} [nonStridentCeilingDb]
 *                                         - Same as stridentCeilingDb but for
 *                                           sibilantClass = "non_strident" (/f/, /θ/).
 *                                           Non-strident events normally sit BELOW
 *                                           surrounding RMS; post-compression they
 *                                           rise to vowel level. A zero or negative
 *                                           value pushes them back below vowel level.
 * @property {number} [naturalCeilingDb]   - Back-compat single ceiling. Used for
 *                                           both classes when neither class-keyed
 *                                           value is provided.
 * @property {number} [reductionRatio]     - Fraction of "excess above ceiling" that
 *                                           gets removed. Near 1.0 flattens excess to
 *                                           the ceiling.
 * @property {number} [maxReductionDb]     - Hard cap on per-event attenuation.
 * @property {number} [contextWindowMs]    - Voiced-context window used to measure the
 *                                           surrounding RMS for natural-ceiling
 *                                           comparison.
 * @property {{ fricativeInMs?: number, fricativeOutMs?: number, affricateInMs?: number, affricateOutMs?: number }} [fades] - Envelope fade timings. Falls back to the preset's `clipGainDeEsser.fades` when absent.
 *
 * @typedef {Object} Preset
 * @property {string} id
 * @property {string} displayName
 * @property {string} description
 * @property {string} audience
 * @property {string} character
 * @property {{ value: number, unit: string }} targetLoudness
 * @property {number} truePeakCeiling
 * @property {number|null} noiseFloorTarget
 * @property {CompressionConfig|CompressionConfig[]} compression
 * @property {ParallelCompressionConfig} parallelCompression
 *
 * @typedef {Object} CompressionConfig
 * @property {number} targetCrestFactorDb  - Target crest factor for output voiced speech (dB). Compression is skipped if input crest factor is already within this value.
 * @property {number} thresholdPercentile  - Percentile of voiced-frame RMS distribution used to anchor the threshold (e.g. 0.75 = 75th percentile).
 * @property {number} attack               - Attack time in ms
 * @property {number} release              - Release time in ms
 * @property {string} eqProfile
 * @property {{ sensitivity: 'standard'|'high'|'none', trigger: number, maxReduction: number, ratio: number }} deEsser
 * @property {'mono'|'preserve'} channelOutput
 * @property {string} defaultOutputProfile
 * @property {boolean} lockedOutputProfile
 * @property {{ enabled: boolean, strength: 'light'|'medium'|'heavy', preserve_early: boolean }} dereverb
 * @property {{ total_max_up_db: number, total_max_down_db: number, target_mode: 'running_median'|'global', target_window_s: number, noise_floor_target_dbfs: number, deadband_db: number, knee_db: number, max_up_db: number, max_down_db: number, subphrase_split_drop_db: number, subphrase_split_min_duration_ms: number, crossfade_ms: number, merge_max_delta_db: number } | null} autoLeveler
 * @property {{ model?: 'demucs'|'convtasnet' }} [separateVocals] - Inline config for the separateVocals stage. model selects the separation backend ('demucs' default).
 * @property {{ model?: 'mossformer2_48k'|'frcrn_16k' }} [clearerVoiceEnhance] - Inline config for the clearerVoiceEnhance stage. model selects the ClearerVoice model ('mossformer2_48k' default).
 * @property {{ enabled: boolean, model?: 'ap-bwe'|'ap_bwe'|'lavasr', postEq?: { enabled: boolean, freq?: number, q?: number, gainDb: number } }} bandwidthExtension - Bandwidth extension; enabled for NE presets, disabled for standard presets. model selects the backend ('ap-bwe' default, 'lavasr'). postEq applies a narrow bell cut after BWE to tame sibilance introduced by HF synthesis.
 * @property {{ model?: 'df3'|'rnnoise'|'dtln', skipBelowDb?: number, vadGate?: { enabled: boolean, rnnoiseThreshold?: number, crossfadeMs?: number, hangoverFrames?: number } }} [noiseReduce] - Noise reduction stage configuration. model selects the backend ('df3' default). skipBelowDb skips this pass entirely if the current noise floor is already below the given dBFS (e.g. -85). vadGate (rnnoise only) restores the dry input on frames where Silero says speech but RNNoise's internal VAD reports speech_prob below rnnoiseThreshold (default 0.30); a short crossfadeMs (default 1 ms) ramp prevents clicks at region boundaries; hangoverFrames (default 2 = 20 ms) right-extends each override forward in time so RNNoise's causal VAD has time to lock onto voicing before the gate hands control back, avoiding the post-fricative vowel-onset dip. When the stage is listed more than once, each call can carry its own model, skipBelowDb, and vadGate.
 */

/** @type {Record<string, Preset>} */
export const PRESETS = {
  acx_audiobook: {
    id: "acx_audiobook",
    displayName: "ACX Audiobook",
    description: "Conservative, transparent processing for audiobook narration",
    audience: "Audiobook narrators",
    character: "Clean, present, natural",
    targetLoudness: { value: -20, unit: "dBFS RMS" },
    truePeakCeiling: -3,
    noiseFloorTarget: -60,
    channelOutput: "mono",
    defaultOutputProfile: "acx",
    lockedOutputProfile: true,
    stages: [
      "decode",
      "monoMixdown",
      // measureBefore and analyzeFramesRaw both read the original
      // (post-mixdown, pre-peakNormalize) audio and write disjoint fields on
      // ctx.results.metrics / ctx.results.beforeMeasurements. measureBefore is
      // an FFmpeg subprocess (volumedetect ± libebur128) while analyzeFramesRaw
      // is in-process JS (Meyda + Silero), so the two overlap cleanly — the
      // FFmpeg subprocess runs on its own core while Node executes the frame
      // analysis on the main thread. analyzeFramesRaw on pre-peakNormalize
      // audio matches the historical behaviour exactly: peakNormalize?.gainDb
      // is undefined at this point so the noise-floor back-fill falls through
      // to gainDb = 0 and assigns the measured value to both metrics and
      // beforeMeasurements — the same outcome the post-peakNorm subtraction
      // path produced.
      { parallel: [
        ["measureBefore"],
        ["analyzeFramesRaw"],
      ] },
      "peakNormalize",
      "humDetect",
      "hpf",
      {
        // Dual-pass noiseReduce runs per silence-aligned chunk and is stitched
        // back together with an equal-power crossfade at each seam. Short files
        // (or files with no qualifying silence) fall through to a single-chunk
        // plan inside the runner — no behaviour change there.
        chunked: [
          { noiseReduce: { model: "df3" } }, //"df3", "rnnoise", "dtln"

          {
            // Second NR pass: RNNoise. Its internal causal GRU VAD operates on
            // 10 ms frames and routinely misclassifies unvoiced fricative onsets
            // (/tʃ/, /s/, /ʃ/, /f/) as noise, suppressing 20–30 ms of audible
            // consonant. The vadGate restores the dry input on frames where the
            // pipeline's Silero v5 VAD (25 ms frames, ~64 ms context) disagrees
            // with RNNoise's verdict — Silero correctly identifies those onsets
            // as speech. A 1 ms linear crossfade at each override-region
            // boundary keeps frame-edge transitions click-free.
            noiseReduce: {
              model: "rnnoise",
              vadGate: {
                enabled: true,
                rnnoiseThreshold: 0.3,
                // 1 ms linear ramp at each override boundary — long enough to
                // suppress clicks at the frame edge, short enough to stay
                // transparent inside a fricative.
                crossfadeMs: 1.0,
                // 20 ms hangover (2 RNNoise frames). RNNoise's causal VAD
                // takes a few frames to lock onto voicing after a
                // fricative→vowel transition; while its speech_prob is still
                // ramping (0.3–0.7 range) it partially attenuates the leading
                // edge of the vowel. The hangover keeps the dry signal active
                // through that ramp so the C→V handoff isn't a level dip.
                hangoverFrames: 2,
              },
            },
          },
        ],
      },
      // Refresh per-frame rmsDbfs after all NR passes complete. The internal
      // noiseReduce update only writes scalar metrics (noiseFloorDbfs,
      // voicedRmsDbfs, etc.) — frame-level energies stay pre-NR until here.
      // Downstream dynamics stages (compression crest-factor, vocalExpander
      // silence-floor P90) need post-NR frame energies to be accurate.
      "remeasureFramesPostNr",

      // clipGainDeEsserAnalyze runs sibilance detection (in-process JS +
      // Python sibilanceEvents subprocess) and writes only metadata —
      // ctx.globalParams.clipGainDeEsser and ctx._f0Contour. It does not
      // touch the audio buffer. autoLeveler and correctiveEQ each rewrite
      // the audio (autoLeveler renders a new WAV; correctiveEQ applies a
      // parametric EQ pass), so they form a single sequential audio chain
      // in the second branch. Both chains read the same pre-leveler audio
      // at fork entry; sibilance event sample positions are valid through
      // autoLeveler (per-clip flat gain, no sample shifts) and correctiveEQ
      // (biquad EQ, also sample-aligned), so clipGainDeEsserApply can still
      // consume the analyze events against the post-EQ audio afterwards.
      { parallel: [
        [
          {
            clipGainDeEsserAnalyze: {
              enabled: true,
              stridentCeilingDb: 6.0,
              nonStridentCeilingDb: -4.0,
              reductionRatio: 0.5,
              maxReductionDb: 8.0,
              minDurationMs: 15,
              contextWindowMs: 80,
              fades: {
                fricativeInMs: 3.0,
                fricativeOutMs: 4.0,
                affricateInMs: 1.5,
                affricateOutMs: 4.5,
              },
            },
          },
        ],
        [
          {
            autoLeveler: {
              total_max_up_db: 10.0,
              total_max_down_db: 10.0,
              target_mode: "global",
              target_window_s: 60,
              noise_floor_target_dbfs: -60,
              deadband_db: 2.0,
              knee_db: 1.5,
              max_up_db: 10.0,
              max_down_db: 10.0,
              subphrase_split_drop_db: 6.0,
              subphrase_split_min_duration_ms: 500,
              crossfade_ms: 30,
              merge_max_delta_db: 6.0,
            },
          },
          "correctiveEQ",
        ],
      ] },
      "clipGainDeEsserApply",
      {
        compression: [
          /*  
          {
            targetCrestFactorDb: 14,
            maxRatio: 6,
            threshold: "auto",
            follow: false,
            attack: 0.1,
            release: 30,
          },
          {
            targetCrestFactorDb: 12,
            maxRatio: 3,
            threshold: "auto",
            follow: true,
            attack: 15,
            release: 120,
          },
         */

          {
            targetCrestFactorDb: 14,
            maxRatio: 5,
            threshold: "auto",
            follow: false,
            attack: 0.5,
            release: 80,
          },
          {
            targetCrestFactorDb: 13,
            maxRatio: 3,
            threshold: "auto",
            follow: true,
            attack: 1.5,
            release: 150,
          },
          {
            targetCrestFactorDb: 12,
            maxRatio: 2,
            threshold: "auto",
            follow: true,
            attack: 3,
            release: 250,
          },
        ],
      },
      {
        parallelCompression: {
          ratio: 20,
          attackMs: 0.1,
          releaseMs: 150,
          makeupGain: "auto",
          wetMix: 0.4,
          vadFadeMs: 5,
          crestGuardThresholdDb: 12,
          // Wet branch is wetMix=1 with auto makeup — sibilants emerge loud
          // after compression. Aggressive ceiling / near-flatten ratio so the
          // compressed sibilant is heavily attenuated on the wet branch and
          // the dry sibilant character predominates at the mix output.
          wetBranchDeEsser: {
            enabled: true,
            stridentCeilingDb: 3.0,
            nonStridentCeilingDb: -8.0,
            reductionRatio: 0.9,
            maxReductionDb: 50.0,
            contextWindowMs: 80,
          },
        },
      },

      {
        chunked: [
          // vocalSaturation is stateless multiband — chunk-safe with the
          // standard 100 ms overlap.
          {
            vocalSaturation: {
              drive: 1.8,
              wetDry: 0.80,
              bias: 0.5,
              lowCrossover: 80,
              midCrossover: 8000,
              softness: 0.95,
              lowDriveMult: 2.5,
              midDriveMult: 0.1,
              highDriveMult: 0.1,
            },
          },

          // clickRemover does local AR-32 detection — each click is a few ms
          // of context, well inside the chunk overlap. Per-chunk click counts
          // sum cleanly in mergeChunkResults so the report still shows the
          // file-level totals.
          /* { clickRemover: { thresholdSigma: 3.5, maxClickMs: 5 } }, */
        ],
      },

          {
            airBoost: {
              gainDb: 6,
              sibilantGainFloor: 0,
              sibilanceDetection: {
                p95_trigger_db: 6.0,
                min_flatness: 0.1,
                broadband_trigger_db: 10.0,
              },
              // Predictive pre-attenuation
              precut: { enabled: true, maxCutDb: 8.0, minExcessDb: 1.5 },
            },
          },
      

      // airBoost is split: analyze runs whole-file (against the stitched
      // post-vocalSaturation audio) so the compliance loop, precut decision,
      // and sibilance event map are file-level. Apply then runs per-chunk
      // in the next chunked block, re-applying the same band params to
      // each chunk via applyAirBoostBands — every chunk inherits identical
      // EQ across seams.

      /*
      {
        airBoostAnalyze: {
          gainDb: 6,
          sibilantGainFloor: 0,
          sibilanceDetection: {
            p95_trigger_db: 6.0,
            min_flatness: 0.1,
            broadband_trigger_db: 10.0,
          },
          // Predictive pre-attenuation
          precut: { enabled: false, maxCutDb: 5.0, minExcessDb: 1.5 },
        },
      },

      {
        chunked: [
          // airBoostApply re-applies the analyze's file-level band params to
          // each chunk and runs the sibilance mask blend with a frame-offset
          // computed from the chunk's carve start (whole-file event indices
          // → chunk-local STFT frames).
          "airBoostApply",

          // resonanceSuppressor IIR attack=15ms / release=80ms — well inside
          // the 100 ms chunk overlap, so any envelope warm-up at a seam is
          // hidden by the equal-power crossfade. Reordered to before
          // referenceEQ so it sits inside this chunked block; referenceEQ
          // stays whole-file because its measured spectrum is taken against
          // a file-level reference curve.
          {
            resonanceSuppressor: [
              {
                depth: 0.67,
                sharpness: 0.8,
                selectivity: 8,
                attack_ms: 15.0,
                release_ms: 80.0,
                max_reduction_db: 36.0,
                freq_floor_hz: 40.0,
                freq_ceil_hz: 20000.0,
                mode: "soft",
              },
            ],
          },
        ],
      },
      */

      /*
      {
        vocalSaturation: {
          drive: 2,
          wetDry: 1,
          bias: 0.5,
          lowCrossover: 80,
          midCrossover: 8000,
          softness: 0.85,
          lowDriveMult: 2.5,
          midDriveMult: 0.1,
          highDriveMult: 0.1,
        },
      },
      { clickRemover: { thresholdSigma: 3.5, maxClickMs: 5 } },
      */

      "referenceEQ",

      {
        roomPresence: {
          enabled: true,
          //ir_path: "../ir/19_CrystalVocal.wav",
          wet: 0.01,
          rt60Ms: 150,
          preDelayMs: 10.0,
          early_reflections: 2,
          normalize_ir: true,
        },

        /*
      {
        spectralSubtraction: {
          enabled: true,
          alphaDd: 0.98,
          beta: 0.15,
          strength: 0.7,
          transientShaper: true,
        },
      },  
      */
        /* {dereverb: {enabled: true, strength: "medium", preserve_early: false}}, */
        //{ separateVocals: { model: "demucs" } },
        /*
      {
        vadGate: {
          enabled: true,
          energyOverrideDb: 24,
          lookaheadMs: 60,
          holdMs: 200,
          attackMs: 5,
          releaseMs: 80,
          floorDb: -110,
        },
      },
      {
        vocalExpander: {
          enabled: false,
          ratio: 2.5,
          highFreqDepth: 1,
          headroomOffsetDb: 6,
          releaseMs: 150,
          attackMs: 50,
          holdMs: 5,
          lookaheadMs: 455,
          maxAttenuationDb: 24,
          detectionBand: { lowHz: 80, highHz: 800 },
        },
      },
      {
        bandwidthExtension: {
          enabled: true,
          model: "lavasr", //"lavasr", "ap-bwe"
          postEq: { enabled: false, freq: 9000, q: 2, gainDb: -3 },
        },
      },
      { bassEnhance: { enabled: true, drive: 3.0, softness: 0.7, bias: 0.5, mix: 0.8, fundamentalCutRatio: 0.9, crossoverFallbackHz: 200 } },
      */
      },

      "normalize",
      "truePeakLimit",
      "measureAfter",
      "acxCertification",
      "qualityAdvisory",
      "encode",
      "extractPeaks",
    ],
  },

  podcast_ready: {
    id: "podcast_ready",
    displayName: "Podcast Ready",
    description: "Punchy, consistent sound for podcast distribution",
    audience: "Podcast hosts",
    character: "Punchy, intimate, consistent",
    targetLoudness: { value: -16, unit: "LUFS" },
    truePeakCeiling: -1,
    noiseFloorTarget: null,
    channelOutput: "preserve",
    defaultOutputProfile: "podcast",
    lockedOutputProfile: false,
    stages: [
      "decode",
      "monoMixdown",
      "measureBefore",
      "peakNormalize",
      "analyzeFramesRaw",
      { clickRemover: { thresholdSigma: 3.5, maxClickMs: 15 } },
      "humDetect",
      "hpf",
      { noiseReduce: { model: "df3" } },
      "remeasureFramesPostNr",
      {
        autoLeveler: {
          total_max_up_db: 6.0,
          total_max_down_db: 8.0,
          target_mode: "running_median",
          target_window_s: 45,
          noise_floor_target_dbfs: -50,
          deadband_db: 1.5,
          knee_db: 1.0,
          max_up_db: 5.0,
          max_down_db: 6.0,
          subphrase_split_drop_db: 6.0,
          subphrase_split_min_duration_ms: 500,
          crossfade_ms: 30,
          merge_max_delta_db: 6.0,
        },
      },
      {
        spectralSubtraction: {
          enabled: true,
          alphaDd: 0.98,
          beta: 0.15,
          strength: 1.0,
          transientShaper: true,
          transientMaxReductionDb: 6,
        },
      },
      /*{ bandwidthExtension: { enabled: false, model: "ap-bwe" } }, */
      /*
      {
        vadGate: {
          enabled: false,
          lookaheadMs: 20,
          holdMs: 80,
          attackMs: 8,
          releaseMs: 40,
          floorDb: -60,
        },
      },*/
      {
        clipGainDeEsser: {
          enabled: true,
          naturalCeilingDb: 8.0,
          reductionRatio: 0.55,
          maxReductionDb: 8.0,
          minDurationMs: 25,
          contextWindowMs: 80,
          fades: {
            fricativeInMs: 3.0,
            fricativeOutMs: 4.0,
            affricateInMs: 1.5,
            affricateOutMs: 4.5,
          },
        },
      },
      "correctiveEQ",
      {
        compression: [
          {
            targetCrestFactorDb: 14,
            maxRatio: 5,
            threshold: "auto",
            follow: false,
            attack: 0.1,
            release: 40,
          },
          {
            targetCrestFactorDb: 10,
            maxRatio: 4,
            threshold: "auto",
            follow: false,
            attack: 5,
            release: 80,
          },
        ],
      },
      {
        parallelCompression: {
          ratio: 10,
          attackMs: 0.4,
          releaseMs: 120,
          makeupGain: "auto",
          wetMix: 0.4,
          vadFadeMs: 10,
          crestGuardThresholdDb: 12,
          // Moderate wet mix — wet sibilants are partially audible at the
          // output. Less aggressive ceiling than ACX so the wet branch
          // contributes more sibilant energy to the overall sound.
          wetBranchDeEsser: {
            stridentCeilingDb: 4.0,
            nonStridentCeilingDb: -3.0,
            reductionRatio: 0.8,
            maxReductionDb: 12.0,
            contextWindowMs: 80,
          },
        },
      },
      /*
      {
        vocalExpander: {
          enabled: true,
          ratio: 2.0,
          highFreqDepth: 0.5,
          headroomOffsetDb: 6,
          releaseMs: 150,
          attackMs: 10,
          holdMs: 20,
          lookaheadMs: 10,
          maxAttenuationDb: 18,
          detectionBand: { lowHz: 80, highHz: 800 },
        },
      },
      */
      // BassEnhance — adds perceived low-end weight via psychoacoustic
      // harmonic synthesis. Runs after parallelCompression so the dynamics
      // pass doesn't gate the harmonics, and before airBoost / EQ so the
      // tonal stages shape the result.
      {
        bassEnhance: {
          drive: 3.0,
          softness: 0.4,
          bias: 0.4,
          mix: 0.35,
          crossoverFallbackHz: 300,
        },
      },
      {
        airBoost: {
          gainDb: 5,
          sibilantGainFloor: 0.25,
          precut: { enabled: true, maxCutDb: 6.0, minExcessDb: 1.0 },
        },
      },
      {
        resonanceSuppressor: {
          depth: 0.65,
          selectivity: 6,
          attack_ms: 8.0,
          release_ms: 60.0,
        },
      },
      {
        vocalSaturation: {
          drive: 2.5,
          wetDry: 1,
          bias: 0.25,
          lowCrossover: 100,
          midCrossover: 7550,
          softness: 0.9,
          lowDriveMult: 7,
          midDriveMult: 0.25,
          highDriveMult: 6.25,
        },
      },
      "referenceEQ",
      {
        roomPresence: {
          enabled: true,
          ir_path: "../ir/CrystalVocal.wav",
          wet: 0.1,
          rt60Ms: 250,
          preDelayMs: 10.0,
          early_reflections: 2,
          normalize_ir: true,
        },
      },
      "normalize",
      "truePeakLimit",
      "measureAfter",
      "acxCertification",
      "qualityAdvisory",
      "encode",
      "extractPeaks",
    ],
  },

  general_clean: {
    id: "general_clean",
    displayName: "General Clean",
    description: "Balanced cleanup for any audio recording",
    audience: "Everyone",
    character: "Pragmatic, balanced",
    targetLoudness: { value: -16, unit: "LUFS" },
    truePeakCeiling: -1,
    noiseFloorTarget: null,
    channelOutput: "preserve",
    defaultOutputProfile: "podcast",
    lockedOutputProfile: false,
    clearervoiceModel: "mossformer2_48k", // or "frcrn_16k"
    stages: [
      "decode",
      "monoMixdown",
      "measureBefore",
      "peakNormalize",
      "analyzeFramesRaw",
      { clickRemover: { thresholdSigma: 3.5, maxClickMs: 10 } },
      "humDetect",
      "hpf",
      { noiseReduce: { model: "df3" } },
      "remeasureFramesPostNr",
      {
        autoLeveler: {
          total_max_up_db: 8.0,
          total_max_down_db: 10.0,
          target_mode: "running_median",
          target_window_s: 30,
          noise_floor_target_dbfs: -50,
          deadband_db: 1.5,
          knee_db: 1.0,
          max_up_db: 6.0,
          max_down_db: 8.0,
          subphrase_split_drop_db: 6.0,
          subphrase_split_min_duration_ms: 500,
          crossfade_ms: 30,
          merge_max_delta_db: 6.0,
        },
      },

      {
        clipGainDeEsser: {
          enabled: true,
          naturalCeilingDb: 7.0,
          reductionRatio: 0.6,
          maxReductionDb: 8.0,
          minDurationMs: 25,
          contextWindowMs: 80,
          fades: {
            fricativeInMs: 3.0,
            fricativeOutMs: 4.0,
            affricateInMs: 1.5,
            affricateOutMs: 4.5,
          },
        },
      },
      {
        compression: {
          mode: "conditional",
          targetCrestFactorDb: 16,
          thresholdPercentile: 0.7,
          attack: 8,
          release: 80,
        },
      },
      {
        parallelCompression: {
          ratio: 20,
          attackMs: 0.3,
          releaseMs: 80,
          makeupGain: "auto",
          wetMix: 0.15,
          vadFadeMs: 8,
          crestGuardThresholdDb: 10,
          // Low wet mix — wet branch is a glue layer, sibilants barely
          // audible. Still apply wet-branch attenuation to keep the dry
          // sibilant character dominant.
          wetBranchDeEsser: {
            stridentCeilingDb: 3.5,
            nonStridentCeilingDb: -3.5,
            reductionRatio: 0.85,
            maxReductionDb: 12.0,
            contextWindowMs: 80,
          },
        },
      },
      // BassEnhance — perceived low-end weight via psychoacoustic harmonics.
      // Conservative mix because General Clean is the catch-all preset and
      // we cannot assume the source has thin low end.
      {
        bassEnhance: {
          drive: 3.0,
          softness: 0.5,
          bias: 0.3,
          mix: 0.3,
          crossoverFallbackHz: 300,
        },
      },
      {
        resonanceSuppressor: {
          depth: 0.7,
          sharpness: 0.6,
          selectivity: 8,
          attack_ms: 8.0,
          release_ms: 50.0,
          max_reduction_db: 12.0,
          freq_floor_hz: 60.0,
          freq_ceil_hz: 18000.0,
        },
      },
      "correctiveEQ",
      "referenceEQ",
      "normalize",
      "truePeakLimit",
      "measureAfter",
      "acxCertification",
      "qualityAdvisory",
      "encode",
      "extractPeaks",
    ],
  },

  noise_eraser: {
    id: "noise_eraser",
    displayName: "Noise Eraser",
    description: "Voice extraction for severely noisy recordings",
    audience: "Noisy recordings",
    character: "Aggressive separation, dry booth quality",
    targetLoudness: { value: -16, unit: "LUFS" },
    truePeakCeiling: -1,
    noiseFloorTarget: null,
    channelOutput: "mono",
    defaultOutputProfile: "podcast",
    lockedOutputProfile: false,
    stages: [
      "decode",
      "measureBefore",
      "peakNormalize",
      "analyzeFramesRaw",
      "humDetect",
      "hpf",
      {
        spectralSubtraction: {
          enabled: true,
          alphaDd: 0.98,
          beta: 0.15,
          strength: 0.8,
          transientShaper: true,
          transientMaxReductionDb: 6,
        },
      },
      { noiseReduce: { model: "df3" } },
      "remeasureFramesPostNr",
      "tonalPretreatment",
      // Separation backend: 'demucs' (default, best quality) or 'convtasnet' (faster).
      // Demucs htdemucs_ft: ~5–10x real-time GPU, ~0.5–1x real-time CPU, ~2–4 GB VRAM.
      // ConvTasNet WHAM!:   ~20–30x real-time GPU, ~5–10x real-time CPU, ~500 MB VRAM.
      { separateVocals: { model: "demucs" } },
      "separationValidation",
      { bandwidthExtension: { enabled: false, model: "ap-bwe" } },
      {
        vocalExpander: {
          enabled: true,
          ratio: 1.5,
          highFreqDepth: 0.25,
          headroomOffsetDb: 4,
          releaseMs: 50,
          attackMs: 2,
          holdMs: 5,
          lookaheadMs: 20,
          maxAttenuationDb: 12,
          detectionBand: { lowHz: 80, highHz: 800 },
        },
      },
      "vocalSaturation",
      {
        compression: [
          {
            targetCrestFactorDb: 15,
            maxRatio: 4,
            threshold: "auto",
            follow: false,
            attack: 0.1,
            release: 40,
          },
          {
            targetCrestFactorDb: 12,
            maxRatio: 4,
            threshold: "auto",
            follow: false,
            attack: 10,
            release: 80,
          },
          {
            targetCrestFactorDb: 12,
            maxRatio: 2.5,
            threshold: "auto",
            follow: false,
            attack: 15,
            release: 120,
          },
        ],
      },
      {
        vocalExpander: {
          enabled: true,
          ratio: 2.0,
          highFreqDepth: 0.5,
          headroomOffsetDb: 6,
          releaseMs: 50,
          attackMs: 2,
          holdMs: 5,
          lookaheadMs: 20,
          maxAttenuationDb: 18,
          detectionBand: { lowHz: 80, highHz: 800 },
        },
      },
      {
        vadGate: {
          enabled: false,
          lookaheadMs: 20,
          holdMs: 80,
          attackMs: 5,
          releaseMs: 30,
          floorDb: -70,
        },
      },
      "autoLeveler",
      { airBoost: { gainDb: 0 } },
      { roomPresence: { enabled: false } },
      "normalize",
      "truePeakLimit",
      "measureAfter",
      "acxCertification",
      "qualityAdvisory",
      "encode",
      "extractPeaks",
    ],
  },
}

/**
 * Expected shape of the processing report returned by the server.
 * @typedef {Object} ProcessingReport
 * @property {{ rms_dbfs: number, lufs_integrated: number|null, true_peak_dbfs: number, noise_floor_dbfs: number }} measurements.before
 * @property {{ rms_dbfs: number, lufs_integrated: number|null, true_peak_dbfs: number, noise_floor_dbfs: number }} measurements.after
 * @property {{ certificate: 'pass'|'fail', checks: object }|undefined} acx_certification - Present only when output_profile = acx
 * @property {{ flags: Array<{ id: string, severity: 'info'|'review', message: string }>, review_recommended: boolean }} quality_advisory
 * @property {string[]} warnings
 */

// --- Helpers ---

export function getDefaultOutputProfile(presetId) {
  return PRESETS[presetId]?.defaultOutputProfile ?? "podcast"
}

export function isOutputProfileLocked(presetId) {
  return PRESETS[presetId]?.lockedOutputProfile === true
}

export function getPresetList() {
  return Object.values(PRESETS)
}

export function getOutputProfileList() {
  return Object.values(OUTPUT_PROFILES)
}

export function formatLoudness(preset) {
  if (!preset) return ""
  const { value, unit } = preset.targetLoudness
  return `${value} ${unit}`
}
