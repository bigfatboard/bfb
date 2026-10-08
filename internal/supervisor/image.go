// ABOUTME: Verifies the provider's running image against its authenticated local installation source.
// ABOUTME: Separates native executable evidence from gate delivery, output text and short-lived launch authority.

package supervisor

import (
	"github.com/qdis/bfb/internal/provider"
)

// inspectProviderImage does not authorize execution or certify a provider
// session. It proves only that this still-owned process is executing the exact
// prepared native executable at the times of these kernel observations.
func inspectProviderImage(process Process, preparation LaunchPreparation) error {
	return inspectImage(process, preparation, InspectProcesses, nativeExecutable)
}

func inspectImage(process Process, preparation LaunchPreparation, processes func() (ProcessTable, error), executable func(int) (string, error)) error {
	if !validRecordedProcess(process) || process.Zombie || process.GroupID != process.PID {
		return failure("containment_unknown")
	}
	before, err := processes()
	current := before[process.PID]
	if err != nil || !process.Same(current) || current.Zombie || current.ParentPID != process.ParentPID || current.GroupID != process.GroupID {
		return failure("containment_unknown")
	}
	// The source hash includes original executable identity, configuration and
	// integration. Missing/replaced sources cannot be re-baselined after exec.
	stamp, err := provider.VerifyInstallationSource(preparation.Installation(nil), preparation.SourceHash)
	if err != nil {
		return err
	}
	path, err := executable(process.PID)
	if err != nil || path != stamp.CanonicalPath {
		return failure("provider_unavailable")
	}
	again, err := provider.VerifyInstallationSource(preparation.Installation(nil), preparation.SourceHash)
	if err != nil || again != stamp {
		return failure("provider_changed")
	}
	// Recreate the dynamic code object to detect an intervening exec as well
	// as a filesystem change. Neither a path nor a signature query alone is proof.
	checked, err := executable(process.PID)
	if err != nil || checked != path {
		return failure("provider_unavailable")
	}
	after, err := processes()
	current = after[process.PID]
	if err != nil || !process.Same(current) || current.Zombie || current.ParentPID != process.ParentPID || current.GroupID != process.GroupID {
		return failure("containment_unknown")
	}
	return nil
}
