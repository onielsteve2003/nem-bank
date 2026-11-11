# Model card: credit-lr-v1 (credit scoring)

Feature CRD-1 / AI-5. Trained in Python (`ml/`), scored in pure Go. Reproduce with `uv run nemml credit`.

## Intended use
Estimate how likely a Nem customer is to miss repayment on a small loan, to set a band (excellent, good, fair, poor), a borrowing ceiling and the reasons shown to the customer. Policy (KYC Tier 3, one loan at a time, no past default) is applied after the model and cannot be overridden by it. The rules scorer in Go is the non-AI fallback and answers if the model cannot load. This is a demo: no real money is lent.

## Data
Generated applicants (21000 train, 9000 test, seed 7) with average monthly salary, account age, active savings goals, loans repaid and loans defaulted. Outcomes are drawn from a hand-written risk function plus hidden noise. Overall default rate 22.8%. No personal data.

## Model
Logistic regression on 5 standardized features; weights below act on the default log-odds, so a negative weight lowers risk. Exported as JSON (`model.json`, SHA-256 `d09959df58de7aa10b2a9fb3a4a0c6abd0456655201e2bfbb45fca1c26c6ce08`); `golden.json` holds 40 cases Go must reproduce within 1e-05.

| Feature | Weight |
|---|---|
| log_salary | -2.276 |
| log_age | -0.510 |
| goals | -0.165 |
| repaid | -0.250 |
| defaulted | +0.400 |

Bands by predicted default probability: excellent below 4%, good below 9%, fair below 18%, otherwise poor (no loan). Reason codes are the features that moved the score most, in plain words.

## Results on held-out applicants
- ROC-AUC: **model 0.8653** against rules baseline 0.7937 (the Go rules' band as a score).
- Brier score: model 0.0887 against 0.1773 for predicting the average for everyone.

| Band | Share of applicants | Predicted default | Observed default |
|---|---|---|---|
| excellent | 8.2% | 3.0% | 3.4% |
| good | 32.0% | 6.5% | 6.4% |
| fair | 32.3% | 12.6% | 13.2% |
| poor | 27.5% | 60.2% | 59.7% |

## Limitations
- **Everything is synthetic.** The data comes from the same function I wrote the model to find, so these numbers prove the pipeline, not real-world accuracy. A real lender would need its own repayment history.
- Only five aggregates are used. No device, location, contacts or social data, deliberately.
- No fairness testing was possible: there are no demographic fields. Account age and salary can proxy for things they should not; a real rollout needs that audit.
- The model is not retrained from live outcomes yet.
