package agent

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"time"

	"github.com/Doout/runwake/internal/model"
	"github.com/Doout/runwake/internal/store"
)

const ProtocolVersion = "1"

var Version = "0.1.0"

type Message struct {
	ProtocolVersion string                `json:"protocol_version,omitempty"`
	Type            string                `json:"type"`
	ConnectionID    string                `json:"connection_id,omitempty"`
	AgentVersion    string                `json:"agent_version,omitempty"`
	AgentKind       string                `json:"agent_kind,omitempty"`
	Metadata        map[string]string     `json:"metadata,omitempty"`
	Inventory       *model.Inventory      `json:"inventory,omitempty"`
	StreamID        string                `json:"stream_id,omitempty"`
	Record          *model.ActivityRecord `json:"record,omitempty"`
	Metric          *model.WorkloadMetric `json:"metric,omitempty"`
	Error           string                `json:"error,omitempty"`
	Timestamp       time.Time             `json:"timestamp"`
}

type Command struct {
	ID            string              `json:"id"`
	Type          string              `json:"type"`
	StreamID      string              `json:"stream_id,omitempty"`
	Request       model.StreamRequest `json:"request,omitempty"`
	MetricRequest model.MetricRequest `json:"metric_request,omitempty"`
	CreatedAt     time.Time           `json:"created_at"`
}

func NewCommand(commandType string) Command {
	return Command{ID: store.NewID("command"), Type: commandType, CreatedAt: time.Now().UTC()}
}

func GenerateToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func VerifyToken(token, encodedHash string) bool {
	expected, err := base64.RawURLEncoding.DecodeString(encodedHash)
	if err != nil || len(expected) != sha256.Size {
		return false
	}
	actual := sha256.Sum256([]byte(token))
	return subtle.ConstantTimeCompare(expected, actual[:]) == 1
}
