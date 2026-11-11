"""The merchant dictionary: the rules half of smart categories (AI-3).

One table feeds three things, so they cannot drift apart: the rules baseline the model
must beat, the synthetic data generator (known merchants), and the dictionary the Go
service loads (`merchants.json`). A keyword matches when its words appear in order in
the normalized text. Matching is on whole words, so "spar" does not match "sparkle".
"""

import re

CLASSES = [
    "food",
    "groceries",
    "transport",
    "airtime_data",
    "bills_utilities",
    "shopping",
    "entertainment",
    "subscriptions",
    "health",
    "education",
    "rent_housing",
    "family",
    "cash",
    "other",
]

# keyword -> category. Real Nigerian merchants and phrases a bank statement would show.
DICTIONARY: dict[str, list[str]] = {
    "food": [
        "chicken republic",
        "kfc",
        "dominos pizza",
        "mr biggs",
        "sweet sensation",
        "the place",
        "cold stone",
        "tantalizers",
        "kilimanjaro",
        "cactus restaurant",
        "burger king",
        "debonairs",
        "item 7",
        "bukka hut",
        "ofada boy",
        "mama cass",
        "jollof",
    ],
    "groceries": [
        "shoprite",
        "spar",
        "ebeano",
        "justrite",
        "market square",
        "hubmart",
        "jendol",
        "park n shop",
        "addide",
        "grocery",
    ],
    "transport": [
        "bolt",
        "uber",
        "indriver",
        "totalenergies",
        "oando",
        "nnpc",
        "conoil",
        "mrs fuel",
        "lagbus",
        "gigm",
        "peace mass transit",
        "abc transport",
        "brt",
        "lekki toll",
        "lcc toll",
        "fuel",
    ],
    "airtime_data": [
        "mtn",
        "airtel",
        "glo",
        "9mobile",
        "etisalat",
        "spectranet",
        "smile",
        "airtime",
        "data bundle",
    ],
    "bills_utilities": [
        "ikedc",
        "ekedc",
        "phed",
        "aedc",
        "kedco",
        "ibedc",
        "eedc",
        "lawma",
        "dstv",
        "gotv",
        "startimes",
        "water corporation",
        "electricity",
        "prepaid meter",
    ],
    "shopping": [
        "jumia",
        "konga",
        "slot",
        "temu",
        "aliexpress",
        "amazon",
        "shein",
        "payporte",
        "jiji",
        "zara",
        "ikeja city mall",
        "palms mall",
        "adidas",
        "nike",
    ],
    "entertainment": [
        "filmhouse",
        "genesis cinemas",
        "silverbird",
        "ozone cinemas",
        "betking",
        "sportybet",
        "bet9ja",
        "nairabet",
        "terra kulture",
        "cinema",
        "concert",
    ],
    "subscriptions": [
        "netflix",
        "spotify",
        "apple music",
        "youtube premium",
        "showmax",
        "prime video",
        "canva",
        "openai",
        "icloud",
        "google one",
        "microsoft 365",
        "github",
        "notion",
        "linkedin premium",
        "audiomack",
    ],
    "health": [
        "medplus",
        "healthplus",
        "reddington",
        "lagoon hospital",
        "evercare",
        "hygeia",
        "avon medical",
        "pharmacy",
        "hospital",
        "clinic",
        "dental",
    ],
    "education": [
        "unilag",
        "covenant university",
        "waec",
        "jamb",
        "neco",
        "udemy",
        "coursera",
        "school fees",
        "lagos business school",
        "tuition",
    ],
    "rent_housing": [
        "rent",
        "landlord",
        "service charge",
        "propertymart",
        "lekki gardens",
        "estate levy",
        "caution fee",
    ],
    "family": [
        "mum",
        "mummy",
        "daddy",
        "dad",
        "brother",
        "sister",
        "aunty",
        "uncle",
        "grandma",
        "pocket money",
        "upkeep",
    ],
    "cash": ["atm", "cash withdrawal", "cash out", "cashout", "pos withdrawal"],
}

_NON_ALNUM = re.compile(r"[^a-z0-9]")


def normalize(text: str) -> str:
    """Lowercase ASCII words; every run of digits becomes a single "0"; all else is a space.

    The Go service implements exactly this (apps/api/internal/categorize); a golden test
    keeps the two in step. Digits carry no meaning in a narration (phone numbers, references)
    but their presence does, so they collapse to one marker.
    """
    out: list[str] = []
    prev = " "
    for ch in text.lower():
        if "a" <= ch <= "z":
            c = ch
        elif "0" <= ch <= "9":
            c = "0"
        else:
            c = " "
        if c == "0" and prev == "0":
            continue
        out.append(c)
        prev = c
    return "".join(out)


def _entries() -> list[tuple[list[str], str]]:
    rows: list[tuple[list[str], str]] = []
    for category, keywords in DICTIONARY.items():
        for kw in keywords:
            words = normalize(kw).split()
            if words:
                rows.append((words, category))
    # Longest keyword first, so "lekki toll" wins over a shorter match.
    rows.sort(key=lambda r: (-len(r[0]), -sum(len(w) for w in r[0])))
    return rows


ENTRIES = _entries()


def lookup(text: str) -> str | None:
    """The dictionary's category for `text`, or None when nothing matches."""
    words = normalize(text).split()
    for kw, category in ENTRIES:
        n = len(kw)
        for i in range(len(words) - n + 1):
            if words[i : i + n] == kw:
                return category
    return None


def export() -> list[dict[str, str]]:
    """The dictionary as the Go service loads it, in match order."""
    return [{"keyword": " ".join(words), "category": category} for words, category in ENTRIES]
