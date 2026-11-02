import { checkScamText, linkReasons, narrationWarning, recipientWarning, scamResult } from './scam';

const codes = (text: string) => checkScamText(text).reasons.map((r) => r.code);

describe('scam message rules', () => {
  it('calls a BVN update with a fake link and an OTP request a likely scam', () => {
    const r = checkScamText(
      'URGENT: your account will be blocked. Update your BVN at http://nem-verify.com and send the OTP.',
    );
    expect(r.verdict).toBe('likely_scam');
    expect(r.reasons.map((x) => x.code)).toEqual(
      expect.arrayContaining([
        'asks_for_secret',
        'bvn_update',
        'threat',
        'urgency',
        'lookalike_domain',
        'insecure_link',
      ]),
    );
    expect(r.score).toBe(1);
  });

  it('spots the "sent to you by mistake" refund trick', () => {
    expect(codes('Bros I transferred 20k to your account by mistake, abeg send am back')).toContain(
      'wrong_transfer',
    );
  });

  it('spots a family "new number" emergency in English and Pidgin', () => {
    expect(codes('Mummy this is my new number, I am stranded')).toContain('family_emergency');
    expect(codes('Na me, I don stuck for Ore. Send 15k quick quick')).toEqual(
      expect.arrayContaining(['family_emergency', 'urgency']),
    );
  });

  it('spots agency impersonation, prizes, fees and secrecy', () => {
    expect(
      codes("EFCC: you have won a promo. Pay the processing fee to claim. Don't tell anyone"),
    ).toEqual(expect.arrayContaining(['impersonation', 'prize', 'advance_fee', 'secrecy']));
  });

  it('finds nothing in an ordinary message', () => {
    const r = checkScamText('See you at the owambe on Saturday. I will bring the jollof.');
    expect(r).toMatchObject({ verdict: 'looks_safe', reasons: [] });
  });

  it('says each reason once however often it matches', () => {
    expect(codes('urgent urgent urgent').filter((c) => c === 'urgency')).toHaveLength(1);
  });
});

describe('link rules', () => {
  it('trusts Nem links and flags short, look-alike, bare-number and disguised ones', () => {
    expect(linkReasons('https://nem-bank-fodx.vercel.app/pay/abc')).toEqual([]);
    expect(linkReasons('https://bit.ly/3xYz')[0]!.code).toBe('short_link');
    expect(linkReasons('https://nembank-secure.ng/login')[0]!.code).toBe('lookalike_domain');
    expect(linkReasons('http://102.89.4.12/claim').map((r) => r.code)).toEqual([
      'ip_link',
      'insecure_link',
    ]);
    expect(linkReasons('https://xn--nm-bank-b1a.com')[0]!.code).toBe('disguised_link');
  });

  it('leaves ordinary websites alone', () => {
    expect(linkReasons('Menu is on https://chickenrepublic.com.ng')).toEqual([]);
  });
});

describe('scoring', () => {
  it('needs more than one weak sign to be suspicious', () => {
    const weak = { code: 'urgency', severity: 'medium', message: '' } as const;
    expect(scamResult([]).verdict).toBe('looks_safe');
    expect(scamResult([weak]).verdict).toBe('looks_safe');
    expect(scamResult([weak, { ...weak, code: 'threat' }]).verdict).toBe('suspicious');
  });
});

describe('inline payment warnings', () => {
  it('warns when the reason for a payment is a fee to receive something', () => {
    expect(narrationWarning('clearance fee for my parcel')?.code).toBe('pay_to_receive');
    expect(narrationWarning('refund, they sent it by mistake')?.code).toBe('refund_request');
    expect(narrationWarning('BVN update')?.code).toBe('account_fix');
    expect(narrationWarning('forex investment')?.severity).toBe('medium');
  });

  it('stays quiet for everyday reasons', () => {
    for (const n of ['Rent', 'school fees', 'owambe asoebi', 'Mum food money', ''])
      expect(narrationWarning(n)).toBeNull();
  });

  it('warns about recipients named like a bank or agency', () => {
    expect(recipientWarning('CBN Refund Desk')?.code).toBe('official_sounding_name');
    expect(recipientWarning('Nem Bank Customer Care')).not.toBeNull();
    expect(recipientWarning('Amaka Obi')).toBeNull();
  });
});
