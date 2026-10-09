/**
 * Chart color tokens. Lightweight Charts draws on canvas and cannot read CSS
 * variables, so the palette shared by both charts lives here. The overlay
 * hues follow a fixed categorical order validated for colorblind separation
 * on the dark chart surface; the Bollinger envelope is deliberately neutral
 * so it reads as context rather than a fourth series.
 */
export const CHART_COLORS = {
  surface: '#0f131a',
  grid: '#1c222c',
  border: '#2a313c',
  text: '#9aa4b2',
  crosshair: '#5d6876',
  up: '#26a69a',
  down: '#ef5350',
  upVolume: 'rgba(38, 166, 154, 0.45)',
  downVolume: 'rgba(239, 83, 80, 0.45)',
  sma20: '#3987e5',
  sma50: '#d95926',
  ema: '#199e70',
  bollinger: '#8b95a3',
  bollingerFill: 'rgba(139, 149, 163, 0.06)',
  equity: '#3987e5',
  benchmark: '#8b95a3',
  drawdown: '#d03b3b',
  drawdownFill: 'rgba(208, 59, 59, 0.25)',
  buyMarker: '#26a69a',
  sellMarker: '#ef5350',
} as const;
