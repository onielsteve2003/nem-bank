package privacy

import (
	"context"

	"github.com/gin-gonic/gin"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
)

// API adapts the service to the contract's strict server; the router embeds it. A nil *API
// answers 501 (and 404 for download links).
type API struct{ svc *Service }

// NewAPI returns the privacy operations for the router.
func NewAPI(svc *Service) *API { return &API{svc: svc} }

// RequestDataExport is POST /v1/privacy/exports.
func (a *API) RequestDataExport(ctx context.Context, _ api.RequestDataExportRequestObject) (api.RequestDataExportResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	r, err := a.svc.RequestExport(ctx)
	if err != nil {
		return nil, err
	}
	return api.RequestDataExport202JSONResponse(r), nil
}

// RequestAccountDeletion is POST /v1/privacy/deletion.
func (a *API) RequestAccountDeletion(ctx context.Context, req api.RequestAccountDeletionRequestObject) (api.RequestAccountDeletionResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	r, err := a.svc.RequestDeletion(ctx, req.Params.XStepUpToken)
	if err != nil {
		return nil, err
	}
	return api.RequestAccountDeletion202JSONResponse(r), nil
}

// DownloadHandler serves an export from its signed, one-time link (not a contract operation:
// the link is the credential, as for attachments).
func (a *API) DownloadHandler(c *gin.Context) {
	if a == nil {
		c.Status(404)
		return
	}
	a.svc.Serve(c.Writer, c.Request, c.Param("id"), c.Query("u"), c.Query("exp"), c.Query("sig"))
}
