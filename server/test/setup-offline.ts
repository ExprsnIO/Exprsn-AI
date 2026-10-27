// Every server test runs offline for the clouds: guardedRequest refuses real AWS, Azure, DigitalOcean and Cloudflare
// hosts (platform/egress.ts). Added 2026-10-20 after a test with a missing fake endpoint reached the real ECS and EKS APIs.
process.env.EXPRSN_TESTS_OFFLINE = '1';
