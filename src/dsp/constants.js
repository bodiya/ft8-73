export const FS = 12000;               // sample rate, Hz
export const NSPS = 1920;              // samples per symbol (160 ms)
export const TONE_SPACING = 6.25;      // Hz (= 1 / 0.16 s)
export const NSYM = 79;                // channel symbols per transmission
export const COSTAS = [3, 1, 4, 0, 6, 5, 2];
export const GRAY_MAP = [0, 1, 3, 2, 5, 6, 4, 7];       // 3-bit value -> tone
export const GRAY_MAP_INV = [0, 1, 3, 2, 6, 4, 5, 7];   // tone -> 3-bit value
export const SYNC_POSITIONS = [0, 36, 72];              // symbol index where each Costas block starts
export const NFFT_SYNC = 2 * NSPS;     // 3840: spectrogram FFT size (3.125 Hz bins, 2 per tone)
export const NSTEP_SYNC = NSPS / 4;    // 480: spectrogram hop (40 ms)
export const DF_SYNC = FS / NFFT_SYNC; // 3.125 Hz
export const TSTEP_SYNC = NSTEP_SYNC / FS; // 0.04 s
export const DT_OFFSET = 0.5;          // seconds: recording starts 0.5 s before the nominal TX start
export const JZ = 62;                  // lag search range, in TSTEP units (+-2.48 s)
export const MLAG = 13;                // "short lag" window for the red spectrum (+-0.52 s)

export function isSyncSymbol(i) { return i < 7 || (i >= 36 && i < 43) || i >= 72; }
export function costasTone(i) {
  if (i < 7) return COSTAS[i];
  if (i >= 36 && i < 43) return COSTAS[i - 36];
  if (i >= 72) return COSTAS[i - 72];
  return -1;
}
