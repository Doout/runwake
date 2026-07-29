package provider

import (
	"context"
	"errors"
	"fmt"

	"github.com/Doout/runwake/internal/model"
)

type Provider interface {
	Test(ctx context.Context) (model.ProviderInfo, error)
	Namespaces(ctx context.Context) ([]string, error)
	ListWorkloads(ctx context.Context) ([]model.Workload, error)
	ListMetrics(ctx context.Context) ([]model.WorkloadMetric, error)
	Stream(ctx context.Context, request model.StreamRequest, out chan<- model.ActivityRecord) error
	StreamMetrics(ctx context.Context, request model.MetricRequest, out chan<- model.WorkloadMetric) error
}

// WorkloadStreamer is an optional provider capability used by the workload
// inventory endpoint. Providers that implement it can surface each workload as
// soon as its backing runtime returns it instead of waiting for a full snapshot.
type WorkloadStreamer interface {
	StreamWorkloads(ctx context.Context, out chan<- model.Workload) error
}

type Factory interface {
	ProviderFor(connection model.Connection) (Provider, error)
}

var ErrUnsupported = errors.New("unsupported connection")

func Unsupported(c model.Connection) error {
	return fmt.Errorf("%w: kind=%s mode=%s", ErrUnsupported, c.Kind, c.Mode)
}
