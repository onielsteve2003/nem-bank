package accounts

import (
	"fmt"
	"time"

	"github.com/johnfercher/maroto/v2"
	"github.com/johnfercher/maroto/v2/pkg/components/code"
	"github.com/johnfercher/maroto/v2/pkg/components/col"
	"github.com/johnfercher/maroto/v2/pkg/components/line"
	"github.com/johnfercher/maroto/v2/pkg/components/row"
	"github.com/johnfercher/maroto/v2/pkg/components/text"
	"github.com/johnfercher/maroto/v2/pkg/config"
	"github.com/johnfercher/maroto/v2/pkg/consts/align"
	"github.com/johnfercher/maroto/v2/pkg/consts/fontstyle"
	"github.com/johnfercher/maroto/v2/pkg/core"
	"github.com/johnfercher/maroto/v2/pkg/props"
)

// The statement PDF (ACC-8). Every page carries the demo disclaimer at the top and, at
// the bottom, the content hash and a QR code linking to the public verification page, so
// any single page can be checked on its own.

var (
	small  = props.Text{Size: 7}
	smallR = props.Text{Size: 7, Align: align.Right}
	label  = props.Text{Size: 8, Style: fontstyle.Bold}
	head   = props.Text{Size: 7, Style: fontstyle.Bold}
	headR  = props.Text{Size: 7, Style: fontstyle.Bold, Align: align.Right}
	stripe = &props.Cell{BackgroundColor: &props.Color{Red: 242, Green: 244, Blue: 247}}
)

func renderStatement(d statementDoc) ([]byte, error) {
	cfg := config.NewBuilder().
		WithPageNumber(props.PageNumber{Pattern: "Page {current} of {total}", Place: props.RightBottom, Size: 7}).
		WithLeftMargin(12).WithRightMargin(12).WithTopMargin(12).
		WithTitle("Nem Bank (demo) account statement", true).
		WithAuthor(BankName, true).
		WithCreationDate(d.IssuedAt).
		Build()
	m := maroto.New(cfg)

	if err := m.RegisterHeader(
		text.NewRow(8, BankName+" - account statement", props.Text{Size: 13, Style: fontstyle.Bold}),
		text.NewRow(5, "Simulated money for a portfolio demo. This is not a real bank document.",
			props.Text{Size: 7, Style: fontstyle.Italic}),
		line.NewRow(3),
	); err != nil {
		return nil, fmt.Errorf("statement header: %w", err)
	}
	if err := m.RegisterFooter(
		row.New(22).Add(
			code.NewQrCol(2, d.URL, props.Rect{Center: true, Percent: 95}),
			col.New(10).Add(
				text.New("Verify this statement at "+d.URL, props.Text{Size: 7, Top: 4, Left: 2}),
				text.New("Verification code "+d.Code, props.Text{Size: 7, Top: 8, Left: 2, Style: fontstyle.Bold}),
				text.New("SHA-256 "+d.SHA256, props.Text{Size: 6, Top: 12, Left: 2}),
			),
		),
	); err != nil {
		return nil, fmt.Errorf("statement footer: %w", err)
	}

	m.AddRows(
		row.New(5).Add(text.NewCol(3, "Account name", label), text.NewCol(9, d.AccountName, small)),
		row.New(5).Add(text.NewCol(3, "Account number", label), text.NewCol(9, d.AccountNumber+" ("+BankName+", "+BankCode+")", small)),
		row.New(5).Add(text.NewCol(3, "Currency", label), text.NewCol(9, d.Currency, small)),
		row.New(5).Add(text.NewCol(3, "Period", label), text.NewCol(9, d.From.Format("2 Jan 2006")+" to "+d.To.Format("2 Jan 2006"), small)),
		row.New(5).Add(text.NewCol(3, "Issued", label), text.NewCol(9, d.IssuedAt.In(lagos).Format("2 Jan 2006 15:04")+" WAT", small)),
		row.New(4),
		row.New(5).Add(
			text.NewCol(3, "Opening balance", head), text.NewCol(3, "Money in", head),
			text.NewCol(3, "Money out", head), text.NewCol(3, "Closing balance", head),
		),
		row.New(6).Add(
			text.NewCol(3, formatAmount(d.Opening), small), text.NewCol(3, formatAmount(d.MoneyIn), small),
			text.NewCol(3, formatAmount(d.MoneyOut), small), text.NewCol(3, formatAmount(d.Closing), small),
		),
		row.New(4),
		row.New(6).Add(
			text.NewCol(2, "Date", head), text.NewCol(4, "Description", head), text.NewCol(2, "Reference", head),
			text.NewCol(1, "Out", headR), text.NewCol(1, "In", headR), text.NewCol(2, "Balance", headR),
		),
	)
	if len(d.Lines) == 0 {
		m.AddRows(text.NewRow(6, "No transactions in this period.", small))
	}
	rows := make([]core.Row, 0, len(d.Lines))
	for i, l := range d.Lines {
		out, in := "", ""
		if l.Amount < 0 {
			out = formatAmount(-l.Amount)
		} else {
			in = formatAmount(l.Amount)
		}
		r := row.New(5).Add(
			text.NewCol(2, l.At.In(lagos).Format(time.DateOnly), small),
			text.NewCol(4, l.Narration, small),
			text.NewCol(2, l.Reference, small),
			text.NewCol(1, out, smallR),
			text.NewCol(1, in, smallR),
			text.NewCol(2, formatAmount(l.BalanceAfter), smallR),
		)
		if i%2 == 1 {
			r.WithStyle(stripe)
		}
		rows = append(rows, r)
	}
	m.AddRows(rows...)

	doc, err := m.Generate()
	if err != nil {
		return nil, fmt.Errorf("render statement: %w", err)
	}
	return doc.GetBytes(), nil
}
