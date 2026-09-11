// ABOUTME: Checks that launchd bootstrap is typed argv and cannot interpret local strings as shell.
// ABOUTME: Validates XML escaping and rejects unscoped service names or relative executable paths.

package daemon

import (
	"bytes"
	"encoding/xml"
	"io"
	"strings"
	"testing"
)

func TestLaunchdPlistEscapesOnlyFixedArguments(t *testing.T) {
	p := testPaths(t)
	p.Root += "/quotes '&<> $(touch nowhere)"
	data, err := LaunchdPlist("/synthetic/BFB & app/bfb", p, ServiceLabel)
	if err != nil {
		t.Fatal(err)
	}
	decoder := xml.NewDecoder(bytes.NewReader(data))
	var values []string
	for {
		token, decodeErr := decoder.Token()
		if decodeErr == io.EOF {
			break
		}
		if decodeErr != nil {
			t.Fatal(decodeErr)
		}
		if start, ok := token.(xml.StartElement); ok && start.Name.Local == "string" {
			var value string
			if decodeErr = decoder.DecodeElement(&value, &start); decodeErr != nil {
				t.Fatal(decodeErr)
			}
			values = append(values, value)
		}
	}
	want := []string{ServiceLabel, "/synthetic/BFB & app/bfb", "--data-dir", p.Root, "daemon", "run"}
	if strings.Join(values, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("argv changed: %+v", values)
	}
	for _, label := range []string{"../../escape", "com.other.service", "com.tenira.bfb.test;cmd"} {
		if _, err = LaunchdPlist("/synthetic/bfb", p, label); err == nil {
			t.Fatal("accepted invalid label")
		}
	}
	if _, err = LaunchdPlist("relative/bfb", p, ServiceLabel); err == nil {
		t.Fatal("accepted relative executable")
	}
}
