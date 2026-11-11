# Model card: fraud-lgbm-v1 (fraud risk scoring)

Feature AI-1. Scored in pure Go with `leaves`; trained in Python (`ml/`). Reproduce with `uv run nemml fraud`.

## Intended use
Score every outgoing transfer before it is sent and return `allow`, `step_up` (ask for more proof) or `hold` (wait for staff review) with reason codes. It runs beside hand-written rules; if the model is unavailable the rules alone decide (non-AI fallback). It is a demo of the technique, not a production fraud system.

## Data
- Source: PaySim-style simulator (Kaggle file not present) plus a synthetic Nigerian pattern generator (`ml/src/nemml/nigeria.py`).
- 393,050 rows after a history warm-up, fraud rate 0.6%.
- Scenarios: apush (273), ato (829), benign (390,809), mule_cashout (939), paysim_drain (200).
- Split by time, not at random: train on the earliest 60% of each source, validate on the next 20%, test on the final 20%, so the test set is the future relative to training.
- Fingerprint `9ef01027958c8718-552559`, seed 7.
- Licences: PaySim is CC BY-SA 4.0 (Lopez-Rojas et al., 2016); the Nigerian generator is original to this repo. No real customer data was used.

## Features
`log_amount`, `amount_zscore`, `amount_to_balance`, `velocity_1h`, `velocity_24h`, `new_beneficiary`, `new_device`, `hour_of_day`, `account_age_days`, `prior_count`. Each uses only the customer's earlier activity (checked by a test that removes the future).

## Results on the held-out test set
78,393 rows, 406 fraud.

| Metric | Rules baseline | LightGBM |
|---|---|---|
| PR-AUC | 0.3268 | **0.9403** |
| ROC-AUC | 0.9046 | 0.9994 |
| Precision@100 | 0.3 | 1.0 |
| Precision@(number of fraud rows) | 0.3842 | 0.8547 |
| Recall when flagging the top 1% | 0.6182 | 0.9754 |

Thresholds are chosen on validation data, then applied unchanged to the test set:

| Decision | Rule | Alert rate | Precision | Recall |
|---|---|---|---|---|
| Rules, step-up or hold | score >= 0.27027 | 0.5% | 38.0% | 38.4% |
| Model, step-up or hold | score >= 0.005749 | 1.3% | 40.5% | 99.0% |
| Rules, hold | score >= 0.567568 | 0.0% | 100.0% | 0.5% |
| Model, hold | score >= 0.232286 | 0.5% | 88.0% | 84.7% |

### By source (PR-AUC, rules vs model)

| Source | Rules | Model |
|---|---|---|
| nigeria | 0.3138 | 0.9314 |
| paysim | 0.7075 | 1.0 |

### Fraud caught by scenario (step-up or hold)

| Scenario | Fraud rows | Rules | Model | Model, hold |
|---|---|---|---|---|
| ato | 157 | 11.5% | 97.5% | 80.2% |
| mule_cashout | 167 | 62.9% | 100.0% | 100.0% |
| apush | 48 | 31.2% | 100.0% | 35.4% |
| paysim_drain | 34 | 52.9% | 100.0% | 100.0% |

## Limitations
- **The data is synthetic.** The fraud patterns were written by me, and the model learns the patterns I wrote. These numbers show the pipeline works; they do not predict performance on real Nigerian fraud.
- PaySim-style fraud (an account drained to a fresh mule) is easy to separate, which is also true of the real PaySim file. Read the Nigerian-source numbers, not the pooled ones, as the more honest measure.
- Authorised push payment scams look like a real customer making a deliberate payment, so they are the weakest scenario. Rules, models and users all struggle here; staff review and customer warnings matter more than scores.
- Reason codes come from the rules, not the model. The model gives a score; the rules explain it.
- No fairness testing was possible because the data has no demographic fields. Features avoid names, phone numbers, location and any personal attribute.
- Attackers adapt. A real deployment needs retraining on labelled cases (the console's fraud queue records them) and drift monitoring.

## Safety
A `hold` never rejects money silently: the customer sees why and staff can release it. The risk engine (T29.3) combines model and rules so the model can only add friction (step-up or hold); it cannot approve something the rules would block.

Model file SHA-256: `6ce25de069b3075b8dc32bd0989fc5ebf1479995690fcdd9ed1cac95418cbaee`.
