"""Nigerian scam message rules (AI-2): the rules half of the scam checker.

The same table, exported as `scam_rules.json`, is loaded by the Go service, so the Python
baseline the model must beat and the production rules cannot drift apart. The patterns are
the ones in `packages/shared/src/scam.ts` (the on-device engine), written to run unchanged in
Python's `re` and Go's RE2: no lookaround, no backreferences. English and Pidgin wording both
count. `unless` removes a false alarm: a bank's own "never share your OTP" notice mentions the
OTP without asking for it.
"""

import re
from dataclasses import dataclass

WEIGHT = {"low": 0.1, "medium": 0.2, "high": 0.45}
BASE_SCORE = 0.02
LIKELY_SCAM_AT = 0.6
SUSPICIOUS_AT = 0.3

_SECRET = r"\b(otp|one[- ]time (pass)?code|pin|cvv|token code|password)\b"
# "Do not share your OTP" is a warning, not a request.
_WARNING = r"\b(do not|don'?t|never|not) (share|disclose|reveal|give|tell)\b"

RULES: list[dict[str, str]] = [
    {
        "code": "asks_for_secret",
        "severity": "high",
        "pattern": _SECRET,
        "unless": _WARNING,
        "message": "It asks for a PIN, OTP or card code. No bank ever asks for these.",
    },
    {
        "code": "bvn_update",
        "severity": "high",
        "pattern": r"\b(bvn|nin)\b.{0,60}\b(update|link|verify|validate|block|expire)",
        "message": '"Update your BVN or NIN" messages are a common scam.',
    },
    {
        "code": "impersonation",
        "severity": "high",
        "pattern": r"\b(cbn|efcc|central bank|customer care|account officer|nem (support|team)|head office)\b",
        "message": "It claims to be a bank or an agency. They never message you for money or codes.",
    },
    {
        "code": "wrong_transfer",
        "severity": "high",
        "pattern": r"\b(sent|transferred|paid)\b.{0,40}\b(by mistake|in error|wrongly)\b|\bsend (it|am) back\b",
        "message": '"I sent money to you by mistake" is a known trick. Let your bank reverse it, never refund it yourself.',
    },
    {
        "code": "advance_fee",
        "severity": "high",
        "pattern": r"\b(send|pay|transfer)\b.{0,30}\b(first|fee|charge|to claim|to receive|to unlock|to release)\b|\b(processing|clearance|customs|activation|release) fee\b",
        "message": "It asks you to pay first to receive money.",
    },
    {
        "code": "family_emergency",
        "severity": "high",
        "pattern": r"\b(this is my new (number|line)|my (phone|number) (got|was) (spoilt|stolen|lost)|i('m| am) stranded|i don stuck)\b",
        "message": 'A "new number" or emergency from family is often a scam. Call their old number first.',
    },
    {
        "code": "threat",
        "severity": "medium",
        "pattern": r"\b(blocked|suspended|restricted|deactivated|frozen|arrest(ed)?)\b",
        "message": "It threatens you to rush you.",
    },
    {
        "code": "urgency",
        "severity": "medium",
        "pattern": r"\b(urgent(ly)?|immediately|within 24 ?h(ou)?rs?|right now|asap|sharp sharp|quick quick)\b",
        "message": "It pushes you to act fast.",
    },
    {
        "code": "prize",
        "severity": "medium",
        "pattern": r"\b(you('ve| have)? won|winner|prize|promo|giveaway|lottery|lucky draw)\b",
        "message": "Prizes you did not enter for are a classic scam.",
    },
    {
        "code": "investment",
        "severity": "medium",
        "pattern": r"\b(double your money|guaranteed (returns?|profit)|\d{2,3}% (profit|returns?|interest)|forex|crypto|ponzi|invest(ment)? plan)\b",
        "message": "Guaranteed or doubled returns are a red flag.",
    },
    {
        "code": "job_or_loan",
        "severity": "medium",
        "pattern": r"\b(loan (is )?approved|job offer|you('ve| have) been (selected|shortlisted))\b",
        "message": "Loans or jobs you did not apply for often end in a fee.",
    },
    {
        "code": "secrecy",
        "severity": "medium",
        "pattern": r"\b(don'?t tell (anyone|anybody)|keep (this|it) (secret|between us)|no tell anybody)\b",
        "message": "It asks you to keep it secret.",
    },
]

_COMPILED = [
    (
        r,
        re.compile(r["pattern"], re.IGNORECASE),
        re.compile(r["unless"], re.IGNORECASE) if "unless" in r else None,
    )
    for r in RULES
]


@dataclass(frozen=True)
class RuleResult:
    codes: list[str]
    score: float


def fired(text: str) -> list[str]:
    """Codes of the rules that fire on `text`."""
    t = text.strip()
    out = []
    for rule, pattern, unless in _COMPILED:
        if pattern.search(t) and not (unless and unless.search(t)):
            out.append(rule["code"])
    return out


def score(codes: list[str]) -> float:
    """Rule score 0-1: a base plus a weight per reason (the app's `scamResult`)."""
    by_code = {r["code"]: r["severity"] for r in RULES}
    return min(1.0, BASE_SCORE + sum(WEIGHT[by_code[c]] for c in codes))


def verdict(value: float) -> str:
    return (
        "likely_scam" if value >= LIKELY_SCAM_AT else "suspicious" if value >= SUSPICIOUS_AT else "looks_safe"
    )


def export() -> dict:
    return {
        "weights": WEIGHT,
        "base": BASE_SCORE,
        "likely_scam_at": LIKELY_SCAM_AT,
        "suspicious_at": SUSPICIOUS_AT,
        "rules": RULES,
    }
