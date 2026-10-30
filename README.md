# release-notify

Posts every production release to **#production-releases** in one standard format, for every product
(TECOP-543). It's the shared record of production changes for the Release Management and Change
Management standard.

Each message shows:
- the product, the environment and the result
- the version, linked to its commit
- who deployed it, and who approved it if there was an approval gate
- product-specific details
- the **changes since the previous successful release**, each with its PR link, author and Linear issue IDs
- links to the pipeline run and the full diff

## Usage

Add it as the **last step of the production deploy job**, with `if: always()` so failures are posted too:

```yaml
    steps:
      # ... deploy steps ...
      - name: Announce release
        if: always()
        uses: fullcast-io/release-notify@v1
        with:
          product: CopyAI
          status: ${{ job.status }}
          details: Heroku copy-ai-prod-v1 · Vercel web-app + admin
          slack-bot-token: ${{ secrets.SLACK_RELEASES_BOT_TOKEN }}
          slack-channel: ${{ vars.SLACK_RELEASES_CHANNEL }}
```

If the deploy is spread over several jobs, add a final job with `needs: [all deploy jobs]` and `if: always()`,
and pass a computed status: `success` only if every deploy job succeeded.

The workflow token needs `contents: read`, `pull-requests: read` and `actions: read`, which lets the action
find the previous successful run of the same workflow.

| Input | Required | Default | Notes |
|---|---|---|---|
| `product` | yes | | `CopyAI`, `Fullcast`, `Revenue Intelligence`, `Ebsta`, `Atrium`, `Infrastructure`, ... |
| `status` | yes | | `success`, `failure` or `cancelled`; usually `${{ job.status }}` |
| `slack-bot-token` | yes | | org secret `SLACK_RELEASES_BOT_TOKEN` |
| `slack-channel` | yes | | org variable `SLACK_RELEASES_CHANNEL` |
| `environment` | | `production` | |
| `version` | | short commit SHA | image tag, release name, ... |
| `sha` | | `github.sha` | the deployed commit, when a manual dispatch deploys a ref other than the workflow's own commit |
| `previous-ref` | | last successful run of this workflow on this branch | commit or tag of the previous release |
| `deployed-by` | | `github.actor` | |
| `approved-by` | | | environment reviewer or QA sign-off |
| `details` | | | one line, e.g. Heroku release or services deployed |
| `dry-run` | | `false` | prints the Slack payload instead of posting it |

A failed notification never fails the deploy. Problems show up as warnings on the run.

## Testing locally

```sh
GITHUB_REPOSITORY=fullcast-io/copy-ai GITHUB_SHA=<sha> GITHUB_RUN_ID=<run id> \
GITHUB_WORKFLOW_REF=fullcast-io/copy-ai/.github/workflows/main_push.yml@refs/heads/develop GITHUB_REF_NAME=develop \
RN_PRODUCT=CopyAI RN_STATUS=success RN_SLACK_CHANNEL=x RN_DRY_RUN=true RN_GITHUB_TOKEN="$(gh auth token)" \
node notify.mjs
```

## Slack setup

A Slack app with the `chat:write` scope, invited to #production-releases. The bot token goes in the org
secret `SLACK_RELEASES_BOT_TOKEN` and the channel ID in the org variable `SLACK_RELEASES_CHANNEL`.

This repository must allow access from other repositories in the organization: Settings → Actions →
General → Access.

Atrium deploys with Jenkins, so it posts the same format from `atrium-jenkins` (TECOP-549).
