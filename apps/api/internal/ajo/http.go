package ajo

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

type API struct {
	svc *Service
}

func NewAPI(svc *Service) *API {
	return &API{svc: svc}
}

func partyJSON(userID uuid.UUID, p identity.CustomerProfile) api.PartySummary {
	return api.PartySummary{
		UserId: userID,
		Name:   p.Name,
		Nemtag: p.Nemtag,
	}
}

func memberToJSON(m MemberView) api.AjoMember {
	return api.AjoMember{
		Member:              partyJSON(m.UserID, m.User),
		Position:            m.Position,
		Status:              api.AjoMemberStatus(m.Status),
		HasReceivedPayout:   m.HasReceivedPayout,
		ContributionsPaid:   m.ContributionsPaid,
		MissedContributions: m.MissedContributions,
	}
}

func groupToJSON(g GroupView) api.AjoGroup {
	members := make([]api.AjoMember, len(g.Members))
	for i, m := range g.Members {
		members[i] = memberToJSON(m)
	}

	inviteURL := g.InviteURL

	out := api.AjoGroup{
		Id:                 g.ID,
		Name:               g.Name,
		Contribution:       accounts.Money(g.Contribution),
		Frequency:          api.AjoFrequency(g.Frequency),
		MemberCount:        g.MemberCount,
		Rotation:           api.AjoGroupRotation(g.Rotation),
		Status:             api.AjoGroupStatus(g.Status),
		Members:            members,
		CurrentCycle:       g.CurrentCycle,
		TotalCycles:        g.TotalCycles,
		PotBalance:         accounts.Money(g.PotBalance),
		GracePeriodHours:   g.GracePeriodHours,
		InviteUrl:          &inviteURL,
		CreatedBy:          partyJSON(g.CreatedByID, g.CreatedBy),
		CreatedAt:          g.CreatedAt,
		NextContributionAt: g.NextContributionAt,
	}

	if g.NextPayout != nil {
		out.NextPayout = &struct {
			Amount api.Money        `json:"amount"`
			At     api.Timestamp    `json:"at"`
			Member api.PartySummary `json:"member"`
		}{
			Amount: accounts.Money(g.NextPayout.Amount),
			At:     g.NextPayout.At,
			Member: partyJSON(g.NextPayout.UserID, g.NextPayout.Member),
		}
	}

	return out
}

func cycleToJSON(c CycleView) api.AjoCycle {
	contribs := make([]api.AjoContribution, len(c.Contributions))
	for i, cb := range c.Contributions {
		contribs[i] = api.AjoContribution{
			Member:   partyJSON(cb.UserID, cb.User),
			Status:   api.AjoContributionStatus(cb.Status),
			Attempts: cb.Attempts,
			PaidAt:   cb.PaidAt,
		}
	}
	return api.AjoCycle{
		Number:        c.CycleNumber,
		DueAt:         c.DueAt,
		PayoutTo:      partyJSON(c.PayoutToID, c.PayoutToUser),
		PayoutAmount:  accounts.Money(c.PayoutAmount),
		PayoutStatus:  api.AjoCyclePayoutStatus(c.PayoutStatus),
		Contributions: contribs,
	}
}

// ListAjoGroups is GET /v1/ajo/groups
func (a *API) ListAjoGroups(ctx context.Context, _ api.ListAjoGroupsRequestObject) (api.ListAjoGroupsResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	list, err := a.svc.List(ctx)
	if err != nil {
		return nil, err
	}
	out := api.ListAjoGroups200JSONResponse{Data: make([]api.AjoGroup, len(list))}
	for i, g := range list {
		out.Data[i] = groupToJSON(g)
	}
	return out, nil
}

// CreateAjoGroup is POST /v1/ajo/groups
func (a *API) CreateAjoGroup(ctx context.Context, req api.CreateAjoGroupRequestObject) (api.CreateAjoGroupResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	if req.Body == nil {
		return nil, problem.Validation(problem.Field("/", "missing", "Request body is required."))
	}

	contrib, err := money.ParseMinor(req.Body.Contribution.AmountMinor, string(req.Body.Contribution.Currency))
	if err != nil {
		return nil, problem.Validation(problem.Field("/contribution", "invalid", "Enter a valid contribution."))
	}

	gracePeriod := 24
	if req.Body.GracePeriodHours != nil {
		gracePeriod = *req.Body.GracePeriodHours
	}

	var startDate time.Time
	if !req.Body.StartDate.IsZero() {
		startDate = req.Body.StartDate.Time
	}

	view, err := a.svc.Create(ctx, CreateGroupInput{
		Name:             req.Body.Name,
		Contribution:     contrib,
		Frequency:        string(req.Body.Frequency),
		MemberCount:      req.Body.MemberCount,
		Rotation:         string(req.Body.Rotation),
		StartDate:        startDate,
		GracePeriodHours: gracePeriod,
		SourceAccountID:  req.Body.SourceAccountId,
	})
	if err != nil {
		return nil, err
	}
	return api.CreateAjoGroup201JSONResponse(groupToJSON(view)), nil
}

// GetAjoGroup is GET /v1/ajo/groups/{group_id}
func (a *API) GetAjoGroup(ctx context.Context, req api.GetAjoGroupRequestObject) (api.GetAjoGroupResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	view, err := a.svc.Get(ctx, req.GroupId)
	if err != nil {
		return nil, err
	}
	return api.GetAjoGroup200JSONResponse(groupToJSON(view)), nil
}

// ListAjoCycles is GET /v1/ajo/groups/{group_id}/cycles
func (a *API) ListAjoCycles(ctx context.Context, req api.ListAjoCyclesRequestObject) (api.ListAjoCyclesResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	cycles, err := a.svc.ListCycles(ctx, req.GroupId)
	if err != nil {
		return nil, err
	}
	out := api.ListAjoCycles200JSONResponse{Data: make([]api.AjoCycle, len(cycles))}
	for i, c := range cycles {
		out.Data[i] = cycleToJSON(c)
	}
	return out, nil
}

// InviteToAjoGroup is POST /v1/ajo/groups/{group_id}/invites
func (a *API) InviteToAjoGroup(ctx context.Context, req api.InviteToAjoGroupRequestObject) (api.InviteToAjoGroupResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	var tags []string
	if req.Body != nil && req.Body.Nemtags != nil {
		tags = *req.Body.Nemtags
	}
	res, err := a.svc.Invite(ctx, req.GroupId, tags)
	if err != nil {
		return nil, err
	}
	invited := make([]api.PartySummary, len(res.Invited))
	for i, p := range res.Invited {
		invited[i] = partyJSON(res.InvitedIDs[i], p)
	}
	return api.InviteToAjoGroup201JSONResponse{
		InviteCode: res.InviteCode,
		InviteUrl:  res.InviteURL,
		ExpiresAt:  res.ExpiresAt,
		Invited:    invited,
	}, nil
}

// LeaveAjoGroup is POST /v1/ajo/groups/{group_id}/leave
func (a *API) LeaveAjoGroup(ctx context.Context, req api.LeaveAjoGroupRequestObject) (api.LeaveAjoGroupResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	if err := a.svc.Leave(ctx, req.GroupId); err != nil {
		return nil, err
	}
	return api.LeaveAjoGroup204Response{}, nil
}

// StartAjoGroup is POST /v1/ajo/groups/{group_id}/start
func (a *API) StartAjoGroup(ctx context.Context, req api.StartAjoGroupRequestObject) (api.StartAjoGroupResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	view, err := a.svc.Start(ctx, req.GroupId)
	if err != nil {
		return nil, err
	}
	return api.StartAjoGroup200JSONResponse(groupToJSON(view)), nil
}

// GetAjoInvite is GET /v1/ajo/invites/{invite_code}
func (a *API) GetAjoInvite(ctx context.Context, req api.GetAjoInviteRequestObject) (api.GetAjoInviteResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	view, err := a.svc.GetInvite(ctx, req.InviteCode)
	if err != nil {
		return nil, err
	}
	return api.GetAjoInvite200JSONResponse(groupToJSON(view)), nil
}

// AcceptAjoInvite is POST /v1/ajo/invites/{invite_code}/accept
func (a *API) AcceptAjoInvite(ctx context.Context, req api.AcceptAjoInviteRequestObject) (api.AcceptAjoInviteResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	if req.Body == nil {
		return nil, problem.Validation(problem.Field("/", "missing", "Request body is required."))
	}
	view, err := a.svc.AcceptInvite(ctx, req.InviteCode, req.Body.SourceAccountId)
	if err != nil {
		return nil, err
	}
	return api.AcceptAjoInvite200JSONResponse(groupToJSON(view)), nil
}
