// Package bills is airtime, data, electricity and cable TV (FR-BILL). The customer pays Nem
// first; Nem then asks a Biller to deliver. A biller that refuses gets the money handed
// back, one that cannot be reached leaves the payment processing until a sweep asks again.
//
// The biller sits behind an interface (architecture §7): the simulated biller is the
// default, and a sandbox adapter for a real aggregator is an implementation of the same
// four methods, not a change to the payment flow.
package bills

import (
	"context"
	"errors"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
)

// Categories (contract BillCategory).
const (
	Airtime     = "airtime"
	Data        = "data"
	Electricity = "electricity"
	CableTV     = "cable_tv"
)

// Networks (contract MobileNetwork).
const (
	MTN        = "mtn"
	Airtel     = "airtel"
	Glo        = "glo"
	NineMobile = "nine_mobile"
)

// Errors a Biller returns. Anything else it returns is treated as "could not reach the
// biller": the payment stays processing and is retried, never reversed on a guess.
var (
	// ErrUnknownBiller means the biller ID is not in the catalog.
	ErrUnknownBiller = errors.New("bills: unknown biller")
	// ErrCustomerNotFound means the meter, smartcard or number does not exist at the biller.
	ErrCustomerNotFound = errors.New("bills: customer not found")
	// ErrVendRejected means the biller definitively refused to deliver. The customer is
	// refunded.
	ErrVendRejected = errors.New("bills: biller rejected the purchase")
)

// Info is one biller in the catalog (contract Biller).
type Info struct {
	ID                 string
	Category           string
	Name               string
	Network            string // empty unless a mobile network
	RequiresValidation bool
	HasProducts        bool
	// MinAmount is the smallest purchase; zero means no minimum.
	MinAmount money.Money
}

// Product is a data bundle or cable plan (contract BillerProduct).
type Product struct {
	ID           string
	Name         string
	Amount       money.Money
	ValidityDays int // zero: no validity
}

// Customer is who the biller says owns a meter or smartcard (contract BillValidation).
type Customer struct {
	ID          string
	Name        string
	Address     string
	CurrentPlan string
}

// VendRequest asks the biller to deliver. Reference is the idempotency key: asking twice
// with the same reference must deliver once and return the same result both times.
type VendRequest struct {
	Reference  string
	BillerID   string
	ProductID  string
	CustomerID string
	Amount     money.Money
}

// VendResult is what a delivered purchase hands back. Token and Units are set for prepaid
// electricity only.
type VendResult struct {
	Token string
	Units string
}

// Biller is a source of bill payments.
type Biller interface {
	// Name identifies the implementation in logs ("simulated", "vtpass_sandbox").
	Name() string
	// Billers lists the catalog.
	Billers(ctx context.Context) ([]Info, error)
	// Products lists a biller's bundles or plans, cheapest first; empty if it has none.
	Products(ctx context.Context, billerID string) ([]Product, error)
	// Validate looks up a meter or smartcard, or returns ErrCustomerNotFound.
	Validate(ctx context.Context, billerID, customerID string) (Customer, error)
	// Vend delivers the purchase. It is idempotent on VendRequest.Reference.
	Vend(ctx context.Context, req VendRequest) (VendResult, error)
}
