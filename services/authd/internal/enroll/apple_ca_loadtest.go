//go:build enrollload

package enroll

import "crypto/x509"

// SetAppleDeviceCAsForLoadTest replaces the pinned Apple Phase 2 CA list inside
// the enrollload benchmark harness only. Compiled out of every production build.
func SetAppleDeviceCAsForLoadTest(certs []*x509.Certificate) {
	appleDeviceCAs = certs
}
