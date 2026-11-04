import { createStartupTimer } from './startup';

it('times the first time Home shows balances, and only that', () => {
  const timer = createStartupTimer(1_000);
  expect(timer.timeToInteractive()).toBeNull();

  timer.markInteractive(2_250);
  expect(timer.timeToInteractive()).toBe(1_250);
  // Coming back to Home later is not a startup.
  timer.markInteractive(9_000);
  expect(timer.timeToInteractive()).toBe(1_250);
});
