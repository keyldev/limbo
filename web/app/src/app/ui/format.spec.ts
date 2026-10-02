import {
  errorPct,
  fmt,
  fmtClock,
  fmtMs,
  rpsToSlider,
  sliderToRps,
  RPS_MAX,
  RPS_MIN,
} from './format';

describe('форматирование', () => {
  it('компактные числа', () => {
    expect(fmt(0)).toBe('0');
    expect(fmt(0.5)).toBe('0.50');
    expect(fmt(950)).toBe('950');
    expect(fmt(1234)).toBe('1.2k');
    expect(fmt(18_400)).toBe('18k');
    expect(fmt(Infinity)).toBe('∞');
  });

  it('время и доли', () => {
    expect(fmtMs(38.4)).toBe('38 мс');
    expect(fmtMs(1500)).toBe('1.50 с');
    expect(fmtClock(65.9)).toBe('01:05');
    expect(errorPct(0.0004)).toBe('0.04%');
    expect(errorPct(0.125)).toBe('12.5%');
  });

  it('логарифмический слайдер трафика покрывает 50…20 000 rps и обратим', () => {
    expect(sliderToRps(0)).toBe(RPS_MIN);
    expect(sliderToRps(1000)).toBe(RPS_MAX);
    for (const rps of [50, 500, 1500, 3000, 20_000]) {
      expect(Math.abs(sliderToRps(rpsToSlider(rps)) - rps) / rps).toBeLessThan(0.02);
    }
  });
});
