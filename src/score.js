// The score of the piece: the soundtrack extracted from the reference performance video
// (~/Movies/涌现AI/20261101-天鹅湖/天鹅湖-四小天鹅芭蕾舞-final.MP4).
// The recording contains: first musical attack → 90.2 s of music → applause to the end (103.03 s).
// The leading 0.672 s of silence has been trimmed; beat period 0.5749 s (≈104.37 BPM) is stable.
// One source of truth for duration / tempo / section map, shared by the audio engine,
// the choreography and the HUD.
//
// Tchaikovsky, Swan Lake — Danse des petits cygnes (public domain). The recording is the
// user-provided reference clip; no other audio is used at runtime.

export const BPM = 104.37;                 // = 60 / 0.5749, measured from the recording
export const BEAT = 60 / BPM;              // ≈ 0.5749 s
export const BEAT_OFFSET = 0.014;          // first downbeat after the trim

export const SCORE = {
  duration: 103.028,          // whole audio: music + applause (music engine length)
  audioDuration: 103.028,
  musicDuration: 90.20,       // music ends / audience applause begins (detected from spectral flatness)
  danceEnd: 89.60,            // choreography ends here — the last musical bars become the bow
  outro: 7.20,                // applause: bow, walk off, lights down
  totalDuration: 96.80,       // music 90.2 s + applause under the curtain call
  bpm: BPM,
  beatOffset: BEAT_OFFSET,
  // rough section map of the reference performance (also drives the HUD act labels)
  sections: [
    { name: 'intro', t: 0, dur: 9.33 },
    { name: 'theme', t: 9.33, dur: 21.33 },
    { name: 'middle', t: 30.66, dur: 30.34 },
    { name: 'reprise', t: 61.0, dur: 19.0 },
    { name: 'coda', t: 80.0, dur: 9.6 },
    { name: 'outro', t: 89.6, dur: 7.2 },     // 谢幕：掌声里鞠躬、退场
  ],
};

export const ACT_NAMES = {
  intro: 'i · 入场',
  theme: 'ii · 队列',
  middle: 'iii · 展翅',
  reprise: 'iv · 回旋',
  coda: 'v · 终幕',
  outro: 'vi · 谢幕',
};
