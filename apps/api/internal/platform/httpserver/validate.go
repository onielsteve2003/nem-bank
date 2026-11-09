package httpserver

import (
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/getkin/kin-openapi/openapi3filter"
	"github.com/getkin/kin-openapi/routers"
	"github.com/getkin/kin-openapi/routers/gorillamux"
	"github.com/gin-gonic/gin"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// RequestValidator checks every request against the contract (path, query and header
// parameters, and the JSON body) before a handler runs. Failures become one 400 problem
// with code validation_failed and a field error per violation, in the contract's shape.
func RequestValidator(spec *openapi3.T) (gin.HandlerFunc, error) {
	// Routes are matched on the path alone. The spec's `servers` name a localhost URL that
	// would never match the host the API runs on in production.
	spec.Servers = nil
	router, err := gorillamux.NewRouter(spec)
	if err != nil {
		return nil, fmt.Errorf("build validation router: %w", err)
	}
	opts := &openapi3filter.Options{
		MultiError: true,
		// The strict handlers bind the value validated here instead of decoding the body twice.
		KeepValidatedValue: true,
		// Authentication is enforced by its own middleware (T23.2), not by the validator.
		AuthenticationFunc: openapi3filter.NoopAuthenticationFunc,
	}
	return func(c *gin.Context) {
		route, pathParams, err := router.FindRoute(c.Request)
		if err != nil {
			// Only routes registered from the contract use this middleware, so a miss means
			// the two disagree; let the handler decide rather than block the request.
			if !errors.Is(err, routers.ErrPathNotFound) && !errors.Is(err, routers.ErrMethodNotAllowed) {
				_ = c.Error(err)
			}
			c.Next()
			return
		}
		in := &openapi3filter.RequestValidationInput{
			Request:    c.Request,
			PathParams: pathParams,
			Route:      route,
			Options:    opts,
		}
		if err := openapi3filter.ValidateRequest(c.Request.Context(), in); err != nil {
			problem.Render(c, problem.Validation(fieldErrors(err)...))
			return
		}
		c.Next()
	}, nil
}

// fieldErrors flattens kin-openapi's error tree into the contract's FieldError list. Body
// fields are JSON Pointers ("/amount/amount_minor"); parameters are "<in>.<name>"
// ("query.limit"). Messages are built from the rule, never from kin-openapi's reason text,
// which repeats the submitted value (and values can be PII).
func fieldErrors(err error) []api.FieldError {
	var out []api.FieldError
	var walk func(err error, param *openapi3.Parameter)
	walk = func(err error, param *openapi3.Parameter) {
		// A type switch, not errors.As: RequestError unwraps to its cause and MultiError
		// matches any member, so errors.As would skip the level that names the parameter.
		switch e := err.(type) { //nolint:errorlint // deliberate: see the comment above
		case openapi3.MultiError:
			for _, inner := range e {
				walk(inner, param)
			}
		case *openapi3filter.RequestError:
			if e.Parameter != nil {
				param = e.Parameter
			}
			if e.Err == nil {
				out = append(out, api.FieldError{Field: fieldFor(param, nil), Code: "invalid", Message: "The value is not valid."})
				return
			}
			walk(e.Err, param)
		case *openapi3.SchemaError:
			code := schemaCode(e.SchemaField)
			out = append(out, api.FieldError{
				Field:   fieldFor(param, e.JSONPointer()),
				Code:    code,
				Message: schemaMessage(code, e.SchemaField, e.Schema),
			})
		case *openapi3filter.ParseError:
			out = append(out, api.FieldError{Field: fieldFor(param, nil), Code: "malformed", Message: "The value could not be parsed."})
		default:
			if unwrapped := errors.Unwrap(err); unwrapped != nil {
				walk(unwrapped, param)
				return
			}
			out = append(out, api.FieldError{Field: fieldFor(param, nil), Code: "invalid", Message: "The value is not valid."})
		}
	}
	walk(err, nil)
	return out
}

func fieldFor(param *openapi3.Parameter, pointer []string) string {
	if param != nil {
		return param.In + "." + param.Name
	}
	if len(pointer) == 0 {
		return "/"
	}
	escaped := make([]string, len(pointer))
	for i, p := range pointer {
		escaped[i] = strings.NewReplacer("~", "~0", "/", "~1").Replace(p)
	}
	return "/" + strings.Join(escaped, "/")
}

// schemaCode turns the JSON Schema keyword that failed into a stable snake_case code.
func schemaCode(keyword string) string {
	switch keyword {
	case "":
		return "invalid"
	case "required":
		return "required"
	case "type", "nullable":
		return "wrong_type"
	case "enum", "const":
		return "not_allowed"
	case "minLength", "minimum", "exclusiveMinimum", "minItems", "minProperties":
		return "too_small"
	case "maxLength", "maximum", "exclusiveMaximum", "maxItems", "maxProperties":
		return "too_large"
	case "pattern", "format":
		return "bad_format"
	case "additionalProperties":
		return "unknown_field"
	default:
		return "invalid"
	}
}

// schemaMessage says what the rule wants, using only the schema's own limits.
func schemaMessage(code, keyword string, schema *openapi3.Schema) string {
	limit := func(v *float64) string {
		if v == nil {
			return ""
		}
		return strconv.FormatFloat(*v, 'f', -1, 64)
	}
	if schema != nil {
		switch keyword {
		case "minLength":
			return fmt.Sprintf("Must be at least %d characters.", schema.MinLength)
		case "maxLength":
			if schema.MaxLength != nil {
				return fmt.Sprintf("Must be at most %d characters.", *schema.MaxLength)
			}
		case "minimum", "exclusiveMinimum":
			if m := limit(schema.Min); m != "" {
				return "Must be at least " + m + "."
			}
		case "maximum", "exclusiveMaximum":
			if m := limit(schema.Max); m != "" {
				return "Must be at most " + m + "."
			}
		case "minItems":
			return fmt.Sprintf("Must have at least %d items.", schema.MinItems)
		case "maxItems":
			if schema.MaxItems != nil {
				return fmt.Sprintf("Must have at most %d items.", *schema.MaxItems)
			}
		case "type":
			if schema.Type != nil && len(*schema.Type) > 0 {
				return "Must be of type " + strings.Join(*schema.Type, " or ") + "."
			}
		}
	}
	switch code {
	case "required":
		return "This field is required."
	case "wrong_type":
		return "The value has the wrong type."
	case "not_allowed":
		return "The value is not one of the allowed values."
	case "too_small":
		return "The value is too small."
	case "too_large":
		return "The value is too large."
	case "bad_format":
		return "The value is not in the expected format."
	case "unknown_field":
		return "This field is not allowed here."
	default:
		return "The value is not valid."
	}
}
