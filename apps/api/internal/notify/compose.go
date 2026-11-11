package notify

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/google/uuid"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/jobs"
)

// draft is one notification a domain event produces for one customer.
type draft struct {
	UserID   uuid.UUID
	Category string
	Title    string
	Body     string
	DeepLink string
	// Role distinguishes the several customers one event can notify (sender and receiver).
	Role string
}

// payload is every field the subscribed topics carry. A topic reads only its own; the rest
// stay zero. Payloads hold IDs and amounts, never names or account numbers.
type payload struct {
	UserID          uuid.UUID `json:"user_id"`
	RecipientUserID uuid.UUID `json:"recipient_user_id"`
	RequesterID     uuid.UUID `json:"requester_id"`
	PayerID         uuid.UUID `json:"payer_id"`
	TransferID      uuid.UUID `json:"transfer_id"`
	RequestID       uuid.UUID `json:"request_id"`
	TransactionID   uuid.UUID `json:"transaction_id"`
	AmountMinor     int64     `json:"amount_minor"`
	Currency        string    `json:"currency"`
	BillingMinor    int64     `json:"billing_minor"`
	BillingCurrency string    `json:"billing_currency"`
	MerchantName    string    `json:"merchant_name"`
	CardLast4       string    `json:"card_last4"`
	DeclineReason   string    `json:"decline_reason"`
	GoalName        string    `json:"goal_name"`
	PrincipalMinor  int64     `json:"principal_minor"`
	PaidOutMinor    int64     `json:"paid_out_minor"`
	TotalMinor      int64     `json:"total_minor"`
	Rate            string    `json:"rate"`
	Platform        string    `json:"platform"`
	DueDate         string    `json:"due_date"`
	Tier            int       `json:"tier"`
	CaseNumber      string    `json:"case_number"`
	DisputeID       uuid.UUID `json:"dispute_id"`
	ConversationID  uuid.UUID `json:"conversation_id"`
	Sender          string    `json:"sender"`
	Status          string    `json:"status"`
}

// Topics lists every event the notifications subscriber listens to. security.duress_triggered
// is deliberately absent: the duress alert is silent, and telling the customer's device
// would tell whoever is forcing them.
var Topics = []string{
	"transfer.completed", "transfer.failed",
	"money_request.created", "money_request.paid",
	"card.settled", "card.declined",
	"credit.loan_disbursed", "credit.loan_repayment", "credit.loan_repaid", "credit.loan_overdue", "credit.loan_defaulted",
	"savings.auto_saved", "savings.auto_save_skipped", "savings.lock_matured",
	"statement.ready", "fx.alert_triggered", "dispute.updated", "support.message",
	"identity.device_bound", "identity.refresh_token_reused", "kyc.updated",
}

// symbols are the currencies the bank holds; anything else prints its code.
var symbols = map[string]string{"NGN": "₦", "USD": "$", "GBP": "£", "EUR": "€"}

// formatMoney writes minor units as "₦5,000" or "$12.50" (no decimals when whole).
func formatMoney(minor int64, currency string) string {
	neg := minor < 0
	if neg {
		minor = -minor
	}
	whole, frac := minor/100, minor%100
	digits := fmt.Sprintf("%d", whole)
	var b strings.Builder
	for i, c := range digits {
		if i > 0 && (len(digits)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(c)
	}
	out := b.String()
	if frac != 0 {
		out += fmt.Sprintf(".%02d", frac)
	}
	prefix := symbols[currency]
	if prefix == "" {
		prefix = currency + " "
	}
	if neg {
		return "-" + prefix + out
	}
	return prefix + out
}

// compose turns an outbox delivery into the notifications it should create. An unknown
// topic or an event with nobody to tell yields none; a payload that does not parse is an
// error, so the delivery is retried and then reported instead of silently dropped.
func compose(d jobs.Delivery) ([]draft, error) {
	var p payload
	if err := json.Unmarshal(d.Payload, &p); err != nil {
		return nil, fmt.Errorf("%s payload: %w", d.Topic, err)
	}
	var out []draft
	add := func(user uuid.UUID, role, category, title, body, link string) {
		if user != uuid.Nil {
			out = append(out, draft{UserID: user, Role: role, Category: category, Title: title, Body: body, DeepLink: link})
		}
	}
	amount := formatMoney(p.AmountMinor, p.Currency)

	switch d.Topic {
	case "transfer.completed":
		link := "nembank://transfers/" + p.TransferID.String()
		add(p.UserID, "sender", "transactions", "Transfer completed", "Your transfer of "+amount+" went through.", link)
		add(p.RecipientUserID, "recipient", "transactions", "Money received", "You received "+amount+" in your Nem account.", link)
	case "transfer.failed":
		add(p.UserID, "sender", "transactions", "Transfer failed",
			"Your transfer of "+amount+" did not go through. The money is back in your account.", "nembank://transfers/"+p.TransferID.String())
	case "money_request.created":
		add(p.PayerID, "payer", "transactions", "New money request", "Someone asked you for "+amount+".", "nembank://pay/requests/"+p.RequestID.String())
	case "money_request.paid":
		add(p.RequesterID, "requester", "transactions", "Request paid", "Your money request was paid.", "nembank://pay/requests/"+p.RequestID.String())
	case "card.settled":
		add(p.UserID, "holder", "transactions", "Card payment",
			formatMoney(p.BillingMinor, p.BillingCurrency)+" at "+orDefault(p.MerchantName, "a merchant")+".", "nembank://transactions/"+p.TransactionID.String())
	case "card.declined":
		add(p.UserID, "holder", "security", "Card payment declined",
			"A payment at "+orDefault(p.MerchantName, "a merchant")+" was declined. If this was not you, freeze the card.", "nembank://cards")
	case "credit.loan_disbursed":
		add(p.UserID, "borrower", "credit", "Loan paid out", formatMoney(p.PrincipalMinor, "NGN")+" is in your account.", "nembank://grow/credit")
	case "credit.loan_repayment":
		add(p.UserID, "borrower", "credit", "Repayment received", "We received "+amount+" towards your loan.", "nembank://grow/credit")
	case "credit.loan_repaid":
		add(p.UserID, "borrower", "credit", "Loan fully repaid", "You have repaid your loan. Well done.", "nembank://grow/credit")
	case "credit.loan_overdue":
		add(p.UserID, "borrower", "credit", "Loan payment overdue", amount+" was due on "+p.DueDate+". Add money so it can be collected.", "nembank://grow/credit")
	case "credit.loan_defaulted":
		add(p.UserID, "borrower", "credit", "Loan in default", "Your loan is more than 60 days overdue. Repay now to protect your credit standing.", "nembank://grow/credit")
	case "savings.auto_saved":
		add(p.UserID, "saver", "savings", "Auto-save done", amount+" moved into "+orDefault(p.GoalName, "your goal")+".", "nembank://grow/savings")
	case "savings.auto_save_skipped":
		add(p.UserID, "saver", "savings", "Auto-save skipped",
			"There was not enough in your account to save "+amount+" into "+orDefault(p.GoalName, "your goal")+".", "nembank://grow/savings")
	case "savings.lock_matured":
		add(p.UserID, "saver", "savings", "Locked savings matured", formatMoney(p.PaidOutMinor, "NGN")+" is back in your account.", "nembank://grow/savings")
	case "statement.ready":
		add(p.UserID, "owner", "transactions", "Statement ready", "Your account statement is ready to download.", "nembank://statements")
	case "fx.alert_triggered":
		add(p.UserID, "owner", "product", "Rate alert", "Your rate alert fired at "+orDefault(p.Rate, "your target")+".", "nembank://fx")
	case "dispute.updated":
		link := "nembank://disputes/" + p.DisputeID.String()
		switch p.Status {
		case "under_review":
			add(p.UserID, "owner", "support", "Dispute under review", "We are looking at "+p.CaseNumber+".", link)
		case "awaiting_customer":
			add(p.UserID, "owner", "support", "We need more from you", "Open "+p.CaseNumber+" to see what we need.", link)
		case "resolved_refunded":
			add(p.UserID, "owner", "support", "Dispute resolved: refunded", p.CaseNumber+" was resolved in your favour. The refund is in your account.", link)
		case "resolved_declined":
			add(p.UserID, "owner", "support", "Dispute closed", p.CaseNumber+" was closed without a refund. Open it to see why.", link)
		}
	case "support.message":
		// The customer's own messages and the automatic welcome need no alert.
		if p.Sender == "agent" {
			add(p.UserID, "owner", "support", "New message from support", "Open the chat to read it.", "nembank://support/"+p.ConversationID.String())
		}
	case "kyc.updated":
		// A submission going to review is the customer's own action: they need no alert for it.
		const link = "nembank://me/verification"
		switch {
		case p.Status == "approved":
			add(p.UserID, "owner", "security", "You are now Tier 3", "Your ID was approved. Higher limits and credit are unlocked.", link)
		case p.Status == "rejected":
			add(p.UserID, "owner", "security", "Your Tier 3 upgrade was not approved", "See why and try again with different documents.", link)
		case p.Status == "resubmit":
			add(p.UserID, "owner", "security", "We need a document again", "One of your photos could not be used. Send a new one to finish Tier 3.", link)
		case p.Tier == 2 && p.Status != "pending_review":
			add(p.UserID, "owner", "security", "You are now Tier 2", "Your identity was verified. Foreign wallets and USD cards are unlocked.", link)
		}
	case "identity.device_bound":
		uid, err := uuid.Parse(d.AggregateID)
		if err != nil {
			return nil, fmt.Errorf("device event aggregate: %w", err)
		}
		add(uid, "owner", "security", "New device added",
			"A new "+orDefault(p.Platform, "")+" device was added to your account. If this was not you, remove it now.", "nembank://security/devices")
	case "identity.refresh_token_reused":
		uid, err := uuid.Parse(d.AggregateID)
		if err != nil {
			return nil, fmt.Errorf("session event aggregate: %w", err)
		}
		add(uid, "owner", "security", "You were signed out",
			"We signed you out because your login was used twice. If this was not you, change your password.", "nembank://security")
	}
	return out, nil
}

func orDefault(s, fallback string) string {
	if strings.TrimSpace(s) == "" {
		return fallback
	}
	return s
}
