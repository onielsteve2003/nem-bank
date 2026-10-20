import { problem } from '@/data';

import { loginErrorMessage } from '../loginForm';
import { otpErrorMessage } from '../otp';
import { weakPinMessage } from '../screens/CreatePinScreen';
import { resetErrorMessage } from '../screens/ForgotPasswordScreen';

// The words behind each refusal in sign-up, login and the resets (AUTH-2/3/4/7/9).

describe('weakPinMessage', () => {
  it('names the birthday when the PIN is the date of birth', () => {
    expect(weakPinMessage('0503', '1994-03-05')).toBe(
      "Don't use your date of birth. Pick another PIN.",
    );
  });

  it.each(['0000', '1234', '9876'])('calls %s too easy to guess', (pin) => {
    expect(weakPinMessage(pin)).toMatch(/^Too easy to guess/);
  });

  it('says nothing about a good PIN', () => {
    expect(weakPinMessage('4826', '1994-03-05')).toBeUndefined();
  });
});

describe('loginErrorMessage', () => {
  it('never says whether the email or the password was wrong', () => {
    const message = loginErrorMessage(problem(401, 'invalid_credentials', 'Email is not right'));
    expect(message).toBe('That email, phone number or password is not right.');
  });

  it('points a rate-limited user at the reset', () => {
    expect(loginErrorMessage(problem(429, 'rate_limited', 'Slow down'))).toMatch(/reset/);
  });

  it('handles offline and unknown failures', () => {
    expect(loginErrorMessage(problem(503, 'offline', 'Offline'))).toBe(
      "You're offline. Reconnect and try again.",
    );
    expect(loginErrorMessage(new Error('boom'))).toBe("We couldn't log you in. Try again.");
  });
});

describe('code and reset messages', () => {
  it('counts attempts down and says when the last one is gone', () => {
    const wrong = problem(422, 'invalid_otp', 'That code is not right');
    expect(otpErrorMessage(wrong, 1)).toBe('That code is not right. 1 attempt left.');
    expect(otpErrorMessage(wrong, 0)).toMatch(/last try/);
    expect(otpErrorMessage(problem(410, 'otp_expired', 'Expired'), 3)).toMatch(/expired/);
  });

  it('shows the bank’s reason for a refused new password', () => {
    const weak = problem(422, 'weak_password', 'Pick a stronger password', {
      errors: [{ field: '/new_password', code: 'weak', message: 'Avoid common words' }],
    });
    expect(resetErrorMessage(weak, 5)).toBe('Avoid common words.');
  });
});
