// ABOUTME: Hosts production daemon components with a test-only TLS proxy and durable synthetic consumer.
// ABOUTME: Runs signed under launchd without an app and never exports private keys or runner tokens.

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

	"github.com/qdis/bfb/internal/auth"
	"github.com/qdis/bfb/internal/checkout"
	"github.com/qdis/bfb/internal/cli"
	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/runner"
)

func main() {
	syscall.Umask(0077)
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
	root := os.Args[2]
	data, err := os.ReadFile(filepath.Join(root, "fixture.json"))
	if err != nil {
		os.Exit(2)
	}
	var config struct {
		ProxyAddress string
		Certificate  string
	}
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
	accept := func(ctx context.Context, enrollment runner.Enrollment, command runner.CommandReference) error {
		directory := filepath.Join(root, "received")
		if err := os.MkdirAll(directory, 0700); err != nil {
			return err
		}
		path := filepath.Join(directory, enrollment.RunnerID+"-"+command.ID)
		file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if errors.Is(err, os.ErrExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if _, err = file.WriteString(command.Kind); err == nil {
			err = file.Sync()
		}
		if closeErr := file.Close(); err == nil {
			err = closeErr
		}
		if err != nil {
			return err
		}
		if pause, _ := os.ReadFile(filepath.Join(root, "pause-command")); string(pause) == command.ID {
			<-ctx.Done()
			return ctx.Err()
		}
		return nil
	}
	manager := runner.NewManager(runner.ManagerOptions{HTTPClient: client, Consumers: map[string]runner.CommandConsumer{"launch": accept, "run_control": accept, "discussion_turn": accept}})
	methods := daemon.NewRegistry()
	if runner.RegisterRPC(methods, manager) != nil || checkout.RegisterRPC(methods) != nil {
		os.Exit(2)
	}
	commands := cli.NewRegistry()
	cli.RegisterDaemon(commands, methods)
	cli.RegisterRunner(commands)
	cli.RegisterCheckout(commands)
	os.Exit(commands.Execute(ctx, os.Args[1:], os.Stdin, os.Stdout))
}
