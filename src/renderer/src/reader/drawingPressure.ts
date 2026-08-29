export interface StylusPressureState {
  maximum: number;
  minimum: number;
  smoothed?: number;
}

export function createStylusPressureState(): StylusPressureState {
  return {
    maximum: 0,
    minimum: 1
  };
}

/**
 * Browser PointerEvents normally expose pressure in the 0..1 range. A small
 * number of Windows digitizers still leak integer device units, so accept the
 * common 10-bit and 16-bit ranges before calibrating the current stroke.
 */
export function normalizeStylusPressure(rawPressure: number, state: StylusPressureState): number {
  const raw = normalizeDevicePressure(rawPressure);
  state.minimum = Math.min(state.minimum, raw);
  state.maximum = Math.max(state.maximum, raw);

  // Keep a useful default range while adapting to pens that never reach 1.0.
  // The curve preserves fine light strokes and still gives hard presses room.
  const lower = Math.min(state.minimum, 0.06);
  const upper = Math.max(state.maximum, 0.65);
  const ranged = clamp((raw - lower) / Math.max(0.01, upper - lower), 0, 1);
  const target = 0.02 + Math.pow(ranged, 1.35) * 0.98;
  const smoothed = state.smoothed === undefined
    ? target
    : state.smoothed + (target - state.smoothed) * 0.65;
  state.smoothed = clamp(smoothed, 0.01, 1);
  return state.smoothed;
}

function normalizeDevicePressure(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  if (value <= 1) {
    return value;
  }
  if (value <= 1_024) {
    return value / 1_024;
  }
  return value / 65_535;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
