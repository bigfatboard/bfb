// ABOUTME: Dispatches the BFB CLI and per-user daemon through registered leaf commands.
// ABOUTME: Handles process cancellation without exposing raw local errors or credentials.

package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/qdis/bfb/internal/appbridge"
	"github.com/qdis/bfb/internal/checkout"
	"github.com/qdis/bfb/internal/cli"
	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/provider"
	"github.com/qdis/bfb/internal/providers"
	"github.com/qdis/bfb/internal/runner"
	"github.com/qdis/bfb/internal/supervisor"
)

func main() {
	syscall.Umask(0077)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	providerRegistry, err := provider.NewRegistry(providers.Descriptors())
	if err != nil {
		panic("invalid compiled provider descriptors")
	}
	var executions *supervisor.Service
	bridge := appbridge.New(appbridge.Options{WakeIntent: func(ctx context.Context, intent string) error {
		return executions.Wake(ctx, intent)
	}})
	accept := func(ctx context.Context, enrollment runner.Enrollment, command runner.CommandReference) error {
		return executions.Accept(ctx, enrollment, command)
	}
	manager := runner.NewManager(runner.ManagerOptions{Consumers: map[string]runner.CommandConsumer{"launch": accept, "run_control": accept}})
	executions = supervisor.NewService(supervisor.ServiceOptions{
		Providers: providerRegistry, Connection: manager.Connection, WakeRunner: manager.Wake,
		OpenTerminal: bridge.OpenTerminal, FocusTerminal: bridge.FocusTerminal,
	})
	methods := daemon.NewRegistry()
	if err := appbridge.RegisterRPC(methods, bridge); err != nil {
		panic("duplicate built-in app operation")
	}
	if err := checkout.RegisterRPC(methods); err != nil {
		panic("duplicate built-in local operation")
	}
	if err := runner.RegisterRPC(methods, manager); err != nil {
		panic("duplicate built-in runner operation")
	}
	if err := supervisor.RegisterRPC(methods, executions); err != nil {
		panic("duplicate built-in execution operation")
	}
	registry := cli.NewRegistry()
	cli.RegisterDaemon(registry, methods)
	cli.RegisterCheckout(registry)
	cli.RegisterRunner(registry)
	cli.RegisterExecution(registry,
		func(ctx context.Context, paths daemon.Paths, intent string) error {
			return supervisor.RunHelper(ctx, paths, intent, providerRegistry)
		},
		func(ctx context.Context, paths daemon.Paths, intent string) error {
			return supervisor.RunExecChild(ctx, paths, intent, providerRegistry)
		})
	os.Exit(registry.Execute(ctx, os.Args[1:], os.Stdin, os.Stdout))
}
