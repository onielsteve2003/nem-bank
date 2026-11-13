"""Training messages for the scam classifier (AI-2).

Two sources, kept apart so each is scored on its own:

* `sms`: the UCI SMS Spam Collection (5,574 real English text messages, 13% spam; Almeida,
  Gomez Hidalgo and Yamakami, 2011; CC BY 4.0). Optional: download it to
  `ml/data/raw/sms_spam/SMSSpamCollection.tsv` (see the README). Without it the pipeline runs
  on the Nigerian messages alone.
* `nigeria`: generated here. Nigerian scam messages (bank impersonation, BVN updates, wrong
  transfers, advance fees, family emergencies, prizes, investments, in English and Pidgin)
  and the legitimate messages they get confused with (bank alerts, real OTP notices that say
  "do not share", delivery notices, everyday chat that happens to say "urgent").

Every generated message carries a template id, and the split is by template: the held-out
messages are worded in ways the model never saw.
"""

import hashlib
import random
from pathlib import Path

import pandas as pd

from nemml import paths

SMS_TSV = paths.DATA_RAW / "sms_spam" / "SMSSpamCollection.tsv"

BANKS = [
    "GTBank",
    "Access Bank",
    "Zenith Bank",
    "UBA",
    "First Bank",
    "Opay",
    "Kuda",
    "Moniepoint",
    "Nem Bank",
    "your bank",
]
NETWORKS = ["MTN", "Glo", "Airtel", "9mobile"]
LINKS = [
    "bit.ly/3xK9aQ",
    "http://gtb-verify.com/login",
    "tinyurl.com/nin-update",
    "http://secure-bvn-update.net",
    "https://nem-bank-secure.xyz/verify",
    "cutt.ly/claimNow",
]
AMOUNTS = ["5,000", "20,000", "50,000", "150,000", "500,000", "1,200,000", "3,500,000"]
FEES = ["2,500", "5,000", "10,500", "15,000", "25,000"]
PHONES = ["08031234567", "07012345678", "09087654321", "08121239876"]
NAMES = ["Chinedu", "Amina", "Tunde", "Ngozi", "Ibrahim", "Bisi", "Emeka", "Halima"]

# (type, template). {bank} {net} {link} {amt} {fee} {phone} {name} {acct} {pct}
SCAM = [
    (
        "bvn",
        "Dear customer, your {bank} account will be blocked within 24 hours. Click {link} to update your BVN now.",
    ),
    (
        "bvn",
        "URGENT: Your NIN and BVN must be verified today or your account will be suspended. Visit {link}",
    ),
    ("bvn", "{bank} notice: BVN validation expires tonight. Update at {link} to avoid restriction."),
    ("bvn", "Abeg oga, your account don block. Click {link} quick quick to verify your BVN."),
    (
        "otp",
        "{bank} Security Alert: we noticed a login on your account. Reply with the OTP sent to you to cancel.",
    ),
    ("otp", "Please send me the code you just received, I used your number by mistake."),
    ("otp", "Customer care here. To reverse the debit we need your PIN and card CVV. Reply now."),
    ("otp", "Abeg send the OTP wey dem send you sharp sharp, na emergency."),
    (
        "wrong",
        "Hello pls I mistakenly sent N{amt} to your account, kindly send it back to {acct}. God bless you.",
    ),
    (
        "wrong",
        "Good day, I transferred N{amt} to you in error. Please send am back to this account {acct} urgently.",
    ),
    ("wrong", "Sorry o, I sent money wrongly to your number. Return N{amt} to {acct}, my brother."),
    (
        "fee",
        "Congratulations! You have been selected for the CBN grant of N{amt}. Pay a processing fee of N{fee} to claim.",
    ),
    ("fee", "Your parcel is held at customs. Pay clearance fee N{fee} to release it today."),
    ("fee", "Your loan of N{amt} is approved. Send N{fee} insurance first to receive the money."),
    (
        "fee",
        "Job offer: you have been shortlisted at a top firm. Pay N{fee} registration fee to confirm your slot.",
    ),
    (
        "family",
        "Hi mum this is my new number, my phone got spoilt. I need urgent help, please send N{amt} now.",
    ),
    (
        "family",
        "Hello it's {name}, this is my new line. I'm stranded and my card is blocked, pls send N{amt}, don't tell anyone.",
    ),
    (
        "family",
        "Daddy, my number was stolen, i don stuck for road. Send N{amt} sharp sharp, I will explain later.",
    ),
    ("prize", "You have won N{amt} in the {net} promo! Call {phone} to claim your prize, hurry."),
    ("prize", "WINNER! Your number was picked in the lucky draw for N{amt}. Pay N{fee} delivery to receive."),
    ("prize", "Giveaway alert: {net} is giving N{amt} to lucky subscribers. Click {link} to receive."),
    (
        "invest",
        "Double your money in 7 days! Guaranteed returns of {pct}% profit with our forex plan. Invest N{fee} now.",
    ),
    (
        "invest",
        "Crypto investment plan: {pct}% returns weekly, no risk. Keep this between us, join at {link}",
    ),
    ("invest", "Abeg join our trading group, we go double your money, {pct}% guaranteed profit every month."),
    (
        "agency",
        "This is EFCC. Your account is under investigation. Pay N{fee} to avoid arrest, don't tell anybody.",
    ),
    (
        "agency",
        "CBN notice: your account is frozen. Contact the account officer on {phone} and pay N{fee} to reactivate.",
    ),
    (
        "agency",
        "{bank} head office: your card is deactivated. Send your PIN to {phone} to reactivate immediately.",
    ),
]

HAM = [
    (
        "alert",
        "Debit Alert: Acct 012***789 debited with NGN{amt} on 11-Nov-2026. Bal: NGN{fee}. Not you? Call 0700 123 4567.",
    ),
    (
        "alert",
        "Credit Alert: Your account has been credited with NGN{amt} from {name}. Available balance NGN{fee}.",
    ),
    ("alert", "{bank}: You have received N{amt} from {name}. Ref 20261111{phone}."),
    ("alert", "Txn Alert: NGN{amt} debited from your account 0123456789 on 11/11/2026. Avail Bal: NGN{fee}."),
    (
        "alert",
        "Dear {name}, your account ***4821 has been credited with N{amt} on 11-Nov-26. Narration: {name}. Bal: N{fee}",
    ),
    ("alert", "Your transfer of N{amt} to {name} was successful. Ref: NEM20261111A8F3K2."),
    ("alert", "POS Debit: N{amt} at SHOPRITE LEKKI. Avail bal N{fee}. Not you? Call 0700 123 4567."),
    ("alert", "Debit Alert: Acct 012***789 debited with NGN{amt} on 11-Nov-2026. Bal: NGN{fee}."),
    ("alert", "NIP transfer of NGN{amt} received from {name}. Your balance is NGN{fee}."),
    ("alert", "Your card ending 4321 was blocked at your request. Visit any branch to get a new one."),
    ("otp", "Your OTP for {bank} is 837291. Valid for 5 mins."),
    ("airtime", "Airtime topup of N{fee} successful for {phone}. Thanks for using {bank}."),
    (
        "utility",
        "Your electricity token 4421-8890-1123-4455 for N{amt} is ready. Thank you for your payment.",
    ),
    ("otp", "Your {bank} OTP is 482913. It expires in 10 minutes. Do not share it with anyone."),
    ("otp", "Use 770231 to confirm your login. Never share this code, we will never ask you for it."),
    (
        "otp",
        "{bank}: your one-time code is 120987. Don't share this PIN or OTP with anyone, including our staff.",
    ),
    ("airtime", "You have purchased N{fee} {net} airtime for {phone}. Thank you for using {bank}."),
    ("airtime", "Your {net} data bundle of 2GB expires on 30-Nov-2026. Dial *131# to renew."),
    ("airtime", "{net}: You have used 90% of your data. Buy more with *131*1#."),
    (
        "delivery",
        "Your Jumia order NG{phone} has been shipped and will arrive on Friday. Track it in the app.",
    ),
    ("delivery", "Your Bolt ride with {name} has ended. Fare N{fee}. Rate your trip."),
    ("utility", "IKEDC: Your token is 1234-5678-9012-3456 for N{amt}. Units: 25.4 kWh. Thank you."),
    ("utility", "Your DSTV subscription expires in 3 days. Recharge in the {bank} app to keep watching."),
    ("chat", "I dey come, wait for me at the junction."),
    ("chat", "See you at church on Sunday. Mum says bring the cake."),
    ("chat", "Please call me urgently, the meeting has been moved to 3pm."),
    ("chat", "I will be there immediately after work, save me a seat."),
    ("chat", "Rent is due on the 1st, I will transfer tomorrow once salary lands."),
    ("chat", "Happy birthday {name}! Wishing you all the best, enjoy your day."),
    ("chat", "Pls send the report before 5pm, the client is waiting."),
    ("chat", "Abeg how far? You don chop? Make we go out later."),
    ("chat", "Dad called, he said call him back when you are free."),
    ("chat", "Thanks for the lunch, I will send you the money for my share on Friday."),
    ("chat", "The account number for the school fees is on the invoice I emailed you."),
    (
        "bank",
        "{bank}: Your card ending 4321 was used at SHOPRITE LEKKI for N{amt}. If this was not you, call 0700 123 4567.",
    ),
    ("bank", "{bank}: Your statement for October is ready. Open the app to view it."),
    ("bank", "Welcome to {bank}! Your account is now active. Download the app to get started."),
]


def _fill(rng: random.Random, template: str) -> str:
    return template.format(
        bank=rng.choice(BANKS),
        net=rng.choice(NETWORKS),
        link=rng.choice(LINKS),
        amt=rng.choice(AMOUNTS),
        fee=rng.choice(FEES),
        phone=rng.choice(PHONES),
        name=rng.choice(NAMES),
        acct=rng.choice(PHONES)[1:],
        pct=rng.choice(["30", "50", "100", "200"]),
    )


OPENERS = ["", "", "", "Dear customer, ", "Hello, ", "Attention: ", "Good day, ", "Hi, "]
CLOSERS = [
    "",
    "",
    "",
    " Thank you.",
    " Act now!",
    " God bless you.",
    " Reply YES to continue.",
    " Ignore if done.",
]


def _noise(rng: random.Random, text: str) -> str:
    text = rng.choice(OPENERS) + text + rng.choice(CLOSERS)
    if rng.random() < 0.2:
        text = text.upper()
    elif rng.random() < 0.2:
        text = text.lower()
    if rng.random() < 0.15:
        text = text.replace("N", "₦", 1) if "N" in text else text
    return text


def nigeria(seed: int = 7, renders: int = 14) -> pd.DataFrame:
    rng = random.Random(seed)
    rows = []
    for label, items in ((1, SCAM), (0, HAM)):
        for kind, template in items:
            for _ in range(renders):
                rows.append(
                    (_noise(rng, _fill(rng, template)), label, "nigeria", f"{kind}:{template[:40]}", kind)
                )
    return pd.DataFrame(rows, columns=["text", "label", "source", "template", "kind"])


def sms(seed: int = 7, path: Path | None = None) -> pd.DataFrame:
    """The UCI collection, de-duplicated; empty when the file has not been downloaded."""
    p = path or SMS_TSV
    if not p.exists():
        return pd.DataFrame(columns=["text", "label", "source", "template", "kind"])
    df = pd.read_csv(p, sep="\t", header=None, names=["tag", "text"], quoting=3, encoding="utf-8", dtype=str)
    df = df.dropna().drop_duplicates(subset="text")
    df["label"] = (df["tag"] == "spam").astype(int)
    df["source"] = "sms"
    df["template"] = df["text"]
    df["kind"] = df["tag"]
    return df[["text", "label", "source", "template", "kind"]].reset_index(drop=True)


def build(seed: int = 7, sms_path: Path | None = None) -> pd.DataFrame:
    df = pd.concat([nigeria(seed), sms(seed, sms_path)], ignore_index=True)
    # Without the SMS file its empty frame is all object columns, which would make the label
    # column object too (and sklearn refuses it as a target).
    df["label"] = df["label"].astype(int)
    return df.sample(frac=1.0, random_state=seed).reset_index(drop=True)


def split(df: pd.DataFrame, seed: int = 7) -> pd.Series:
    """train / val / test by template (60/20/20): a held-out message's wording is unseen.

    For the SMS collection each message is its own template, so this is a plain random split.
    """

    def bucket(template: str) -> str:
        h = int(hashlib.sha256(f"{seed}:{template}".encode()).hexdigest()[:8], 16) % 100
        return "train" if h < 60 else "val" if h < 80 else "test"

    return df["template"].map(bucket)
