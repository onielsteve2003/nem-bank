"""Synthetic labelled narrations for smart categories (AI-3).

No public dataset has Nigerian bank narrations, so they are generated: the real merchants
from the dictionary, a long tail of merchants that are *not* in it (invented names built
the way small Nigerian businesses are named), and free-text narrations people type.
Everything is seeded. Rows carry an `entity` so the split is by merchant, not by row: the
test set contains merchants the model never saw, which is the situation that matters.
"""

import hashlib
import random

import pandas as pd

from nemml.merchants import CLASSES, DICTIONARY

# Words that make a business's category obvious to a reader, which is what the model learns.
SUFFIXES: dict[str, list[str]] = {
    "food": [
        "Kitchen",
        "Buka",
        "Restaurant",
        "Eatery",
        "Grills",
        "Bakery",
        "Cafe",
        "Foods",
        "Chops",
        "Bar and Grill",
        "Suya Spot",
    ],
    "groceries": [
        "Supermarket",
        "Provisions",
        "Mart",
        "Stores",
        "Fresh Market",
        "Grocers",
        "Mini Mart",
        "Foodstuff",
    ],
    "transport": [
        "Cab Services",
        "Motors",
        "Fuel Station",
        "Filling Station",
        "Petrol",
        "Transport",
        "Car Hire",
        "Parking",
        "Ride",
    ],
    "airtime_data": ["Airtime Vendor", "Data Plug", "Recharge Hub", "Telecom Services", "VTU"],
    "bills_utilities": [
        "Electricity",
        "Power Distribution",
        "Water Board",
        "Waste Management",
        "Cable TV",
        "Utility Services",
    ],
    "shopping": [
        "Fashion",
        "Boutique",
        "Electronics",
        "Gadgets",
        "Shoes",
        "Furniture",
        "Online Store",
        "Fabrics",
        "Beauty Supply",
        "Plaza",
    ],
    "entertainment": [
        "Cinemas",
        "Lounge",
        "Games Arena",
        "Night Club",
        "Event Tickets",
        "Sports Bar",
        "Amusement Park",
    ],
    "subscriptions": [
        "Premium Monthly",
        "Subscription",
        "Membership",
        "Pro Plan",
        "Streaming",
        "Cloud Storage",
    ],
    "health": [
        "Pharmacy",
        "Clinic",
        "Hospital",
        "Diagnostics",
        "Dental",
        "Medical Centre",
        "Chemist",
        "Optical",
        "Wellness",
    ],
    "education": [
        "School",
        "Academy",
        "College",
        "Tutorials",
        "Books",
        "Exam Fees",
        "University",
        "Training Institute",
        "Nursery",
    ],
    "rent_housing": [
        "Properties",
        "Estate Agent",
        "Real Estate",
        "Facility Management",
        "Housing",
        "Apartments",
    ],
    "cash": ["ATM Withdrawal", "POS Cash", "Cash Out", "Cash Advance"],
    "other": [
        "Ventures",
        "Enterprises",
        "Global Services",
        "Nigeria Limited",
        "Concepts",
        "Resources",
        "Solutions",
    ],
}
# "other" shares its suffixes with nothing else on purpose: a business whose name says nothing.

NAMES = [
    "Ade",
    "Chuks",
    "Bisi",
    "Emeka",
    "Ngozi",
    "Tunde",
    "Funke",
    "Ibrahim",
    "Grace",
    "Lekki",
    "Yaba",
    "Ikeja",
    "Surulere",
    "Abuja",
    "Garki",
    "Wuse",
    "Kano",
    "Enugu",
    "Ikoyi",
    "Ajah",
    "Festac",
    "Maryland",
    "Oluwaseun",
    "Chinedu",
    "Amina",
    "Blessing",
    "Kemi",
    "Segun",
    "Halima",
    "Uche",
    "Royal",
    "Golden",
    "Divine",
    "Unity",
    "Peace",
    "Faith",
    "Prime",
    "Elite",
    "Crown",
    "Victory",
    "Zenith",
    "Alpha",
]
LOCATIONS = ["LAGOS", "LEKKI", "IKEJA", "ABUJA", "PH", "YABA", "VI", "IBADAN", "KANO", "ENUGU", "AJAH"]
WRAPS = [
    "POS/{n}/{loc}",
    "{n} {loc} NG",
    "{n}",
    "WEB*{n}",
    "PAYSTACK*{n}",
    "FLW*{n}",
    "{n} LTD",
    "PURCHASE {n}",
    "NIP/{n}/{ref}",
    "{n} {loc}",
    "CARD PAYMENT {n}",
    "{n} 0{ref}",
]

PHRASES: dict[str, list[str]] = {
    "food": [
        "lunch money",
        "dinner with friends",
        "suya and drinks",
        "breakfast",
        "pizza night",
        "party food",
        "restaurant bill",
        "takeaway",
        "rice and stew",
        "food order",
    ],
    "groceries": [
        "groceries",
        "foodstuff for the month",
        "market money",
        "provisions",
        "fruits and vegetables",
        "monthly shopping for the house",
        "tomatoes and pepper",
    ],
    "transport": [
        "transport fare",
        "fuel for the car",
        "uber home",
        "bus fare",
        "car park",
        "taxi",
        "okada fare",
        "trip to office",
        "petrol money",
    ],
    "airtime_data": [
        "airtime topup",
        "data subscription",
        "recharge card",
        "buy data",
        "mtn airtime",
        "glo data bundle",
    ],
    "bills_utilities": [
        "light bill",
        "nepa bill",
        "electricity token",
        "cable subscription renewal",
        "water bill",
        "waste bill",
        "prepaid meter topup",
    ],
    "shopping": [
        "new shoes",
        "clothes",
        "phone case",
        "online order",
        "gift for friend",
        "furniture",
        "wedding aso ebi",
        "laptop bag",
    ],
    "entertainment": [
        "cinema tickets",
        "concert tickets",
        "game night",
        "club entry",
        "betting",
        "football viewing centre",
        "party ticket",
    ],
    "subscriptions": [
        "monthly subscription",
        "annual plan renewal",
        "premium membership",
        "streaming plan",
        "cloud storage plan",
        "software licence",
    ],
    "health": [
        "hospital bill",
        "drugs from the chemist",
        "malaria treatment",
        "dental checkup",
        "lab test",
        "medical refill",
        "eye glasses",
    ],
    "education": [
        "school fees",
        "textbooks",
        "exam registration",
        "course payment",
        "tutor payment",
        "lesson fees",
        "uniform and books",
    ],
    "rent_housing": [
        "house rent",
        "rent balance",
        "apartment rent for the year",
        "agent fee",
        "landlord payment",
        "service charge",
        "rent top up",
    ],
    "family": [
        "for mum",
        "upkeep for dad",
        "pocket money for my brother",
        "sister school allowance",
        "support for grandma",
        "aunty upkeep",
        "monthly allowance for parents",
        "for my uncle",
    ],
    "cash": ["cash withdrawal", "atm withdrawal", "pos cash", "cash for the weekend", "withdraw cash"],
    "other": [
        "payment",
        "misc",
        "transfer ref",
        "thanks",
        "balance",
        "as discussed",
        "for you",
        "payment for last week",
        "settlement",
        "ok",
    ],
}


def _typo(rng: random.Random, s: str) -> str:
    if len(s) < 5:
        return s
    i = rng.randrange(1, len(s) - 1)
    kind = rng.randrange(3)
    if kind == 0:
        return s[:i] + s[i + 1 :]  # dropped letter
    if kind == 1:
        return s[:i] + s[i + 1] + s[i] + s[i + 2 :]  # swapped letters
    return s[:i] + s[i] + s[i:]  # doubled letter


def _case(rng: random.Random, s: str) -> str:
    return rng.choice([s.upper(), s.lower(), s, s.upper()])


def _ref(rng: random.Random) -> str:
    return str(rng.randrange(10_000, 99_999_999))


def _render(rng: random.Random, merchant: str, typo_rate: float) -> str:
    name = _typo(rng, merchant) if rng.random() < typo_rate else merchant
    wrap = rng.choice(WRAPS)
    text = wrap.format(n=_case(rng, name), loc=rng.choice(LOCATIONS), ref=_ref(rng))
    return text[:120]


def generate(
    seed: int = 7, longtail_per_class: int = 140, renders: int = 6, typo_rate: float = 0.18
) -> pd.DataFrame:
    """Rows of (text, category, entity, kind). `kind` is dictionary, longtail or phrase."""
    rng = random.Random(seed)
    rows: list[tuple[str, str, str, str]] = []

    for category, keywords in DICTIONARY.items():
        if category == "family":
            continue  # family words are phrases, handled below with their own templates
        for kw in keywords:
            for _ in range(renders):
                rows.append((_render(rng, kw.title(), typo_rate), category, kw, "dictionary"))

    for category in CLASSES:
        if category == "family" or category not in SUFFIXES:
            continue
        seen: set[str] = set()
        while len(seen) < longtail_per_class:
            n = rng.choice(NAMES)
            if rng.random() < 0.4:
                n += " " + rng.choice(NAMES)
            name = f"{n} {rng.choice(SUFFIXES[category])}"
            if name in seen:
                continue
            seen.add(name)
            for _ in range(renders):
                rows.append((_render(rng, name, typo_rate), category, name, "longtail"))

    for category, phrases in PHRASES.items():
        for phrase in phrases:
            for _ in range(renders * 2):
                text = phrase
                if rng.random() < 0.3:
                    text += " " + _ref(rng)
                if rng.random() < 0.15:
                    text = _typo(rng, text)
                rows.append((_case(rng, text) if rng.random() < 0.3 else text, category, phrase, "phrase"))

    df = pd.DataFrame(rows, columns=["text", "category", "entity", "kind"])
    return df.sample(frac=1.0, random_state=seed).reset_index(drop=True)


def split(df: pd.DataFrame, seed: int = 7) -> pd.Series:
    """train / val / test by entity (60/20/20), so test merchants are never seen in training."""

    def bucket(entity: str) -> str:
        h = int(hashlib.sha256(f"{seed}:{entity}".encode()).hexdigest()[:8], 16) % 100
        return "train" if h < 60 else "val" if h < 80 else "test"

    return df["entity"].map(bucket)
