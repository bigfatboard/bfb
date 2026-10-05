// ABOUTME: Runs production daemon and runner components against a pinned disposable Worker TLS endpoint.
// ABOUTME: Keeps synthetic enrollment credentials inside the signed daemon and supports exact cleanup.

package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/qdis/bfb/internal/agentwork"
	"github.com/qdis/bfb/internal/auth"
	"github.com/qdis/bfb/internal/cli"
	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/runner"
	"github.com/qdis/bfb/internal/supervisor"
)

func main() {
	syscall.Umask(0077)
	if len(os.Args) == 6 && os.Args[1] == "fixture-supervise" {
		os.Exit(fixtureSupervise(os.Args[2], os.Args[3], os.Args[4], os.Args[5]))
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if len(os.Args) == 4 && os.Args[1] == "cleanup" {
		store, err := auth.NewKeychain()
		if err != nil {
			os.Exit(3)
		}
		for _, kind := range []auth.CredentialKind{auth.RunnerToken, auth.RunnerKey} {
			err := store.Delete(ctx, auth.CredentialRef{Kind: kind, WorkspaceID: os.Args[2], ID: os.Args[3]})
			if err != nil && !errors.Is(err, auth.ErrCredentialNotFound) {
				os.Exit(4)
			}
		}
		return
	}
	if len(os.Args) < 3 || os.Args[1] != "--data-dir" {
		os.Exit(2)
	}
	data, err := os.ReadFile(filepath.Join(os.Args[2], "fixture.json"))
	if err != nil {
		os.Exit(2)
	}
	var config struct{ ProxyAddress, Certificate string }
	if json.Unmarshal(data, &config) != nil {
		os.Exit(2)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM([]byte(config.Certificate)) {
		os.Exit(2)
	}
	client := &http.Client{Transport: &http.Transport{
		TLSClientConfig: &tls.Config{RootCAs: roots, ServerName: "example.com", MinVersion: tls.VersionTLS12},
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, config.ProxyAddress)
		},
	}}
	manager := runner.NewManager(runner.ManagerOptions{HTTPClient: client})
	executions := supervisor.NewService(supervisor.ServiceOptions{})
	methods := daemon.NewRegistry()
	if runner.RegisterRPC(methods, manager) != nil || supervisor.RegisterRPC(methods, executions) != nil || agentwork.RegisterRPC(methods, manager.Connection, executions.CheckAgentOwnership) != nil {
		os.Exit(2)
	}
	commands := cli.NewRegistry()
	cli.RegisterDaemon(commands, methods)
	os.Exit(commands.Execute(ctx, os.Args[1:], os.Stdin, os.Stdout))
}
