import { useState } from "react"
import { api, type SlackStatus } from "@/api"
import { SettingRow } from "@/components/shared/setting-row"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { slackQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_TEST_EMAILS = 10

const parseEmails = (value: string): string[] => [
  ...new Set(
    value
      .split(/[\s,;]+/)
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  ),
]

export function SlackDeliverySettings({ slack }: { slack: SlackStatus }) {
  const initialEmail = slack.slack_email ?? slack.account_email
  const [email, setEmail] = useState(slack.slack_email ?? "")
  const [testEmails, setTestEmails] = useState(initialEmail)
  const [testSummary, setTestSummary] = useState<string | null>(null)
  const normalizedEmail = email.trim().toLowerCase()
  const savedEmail = slack.slack_email ?? ""
  const emailInvalid = !!normalizedEmail && !EMAIL.test(normalizedEmail)

  const saveEmail = useApiMutation({
    mutationFn: (value: string | null) => api.setSlackEmail(value),
    success: "Slack delivery email saved",
    invalidate: [slackQuery().queryKey],
  })
  const testDm = useApiMutation({
    mutationFn: (emails: string[]) => api.sendSlackTestDm(emails),
    onSuccess: (result) => {
      const failed = result.results.filter((item) => !item.ok)
      setTestSummary(
        failed.length
          ? `${result.sent} of ${result.total} delivered. ${failed.map((item) => `${item.email}: ${item.reason ?? "failed"}`).join(" · ")}`
          : `${result.sent} of ${result.total} delivered.`,
      )
    },
  })

  const recipients = parseEmails(testEmails)
  const testInvalid = recipients.some((value) => !EMAIL.test(value))
  const testTooLarge = recipients.length > MAX_TEST_EMAILS

  return (
    <>
      <SettingRow
        htmlFor="slack-delivery-email"
        label="Slack delivery email"
        description={
          emailInvalid
            ? "Enter a valid email address."
            : `Used only in ${slack.team_name ?? "this Slack workspace"}. Leave it empty to use ${slack.account_email}. A linked Slack account still takes priority.`
        }
      >
        <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
          <Input
            id="slack-delivery-email"
            data-testid="slack-delivery-email"
            type="email"
            value={email}
            placeholder={slack.account_email}
            onChange={(event) => setEmail(event.target.value)}
            className="w-full sm:w-64"
          />
          <Button
            data-testid="slack-delivery-email-save"
            variant="outline"
            size="sm"
            disabled={
              saveEmail.isPending || emailInvalid || normalizedEmail === savedEmail.toLowerCase()
            }
            loading={saveEmail.isPending}
            onClick={() => saveEmail.mutate(normalizedEmail || null)}
          >
            Save
          </Button>
        </div>
      </SettingRow>
      <SettingRow
        htmlFor="slack-test-emails"
        label="Test Slack DMs"
        description={
          testInvalid
            ? "One or more email addresses are invalid."
            : testTooLarge
              ? `Enter no more than ${MAX_TEST_EMAILS} email addresses.`
              : (testSummary ??
                `Paste up to ${MAX_TEST_EMAILS} email addresses. Derive sends one fixed test through ${slack.team_name ?? "this workspace's Slack"}.`)
        }
      >
        <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
          <Input
            id="slack-test-emails"
            data-testid="slack-test-emails"
            type="text"
            inputMode="email"
            value={testEmails}
            placeholder="you@company.com, teammate@company.com"
            onChange={(event) => {
              setTestEmails(event.target.value)
              setTestSummary(null)
            }}
            className="w-full sm:w-80"
          />
          <Button
            data-testid="slack-test-dm"
            variant="outline"
            size="sm"
            disabled={testDm.isPending || recipients.length === 0 || testInvalid || testTooLarge}
            loading={testDm.isPending}
            onClick={() => testDm.mutate(recipients)}
          >
            Send test DM
          </Button>
        </div>
      </SettingRow>
    </>
  )
}
