# Instantly API v2 — condensed reference (generated from api_v2.json)

Base: https://api.instantly.ai · Auth: `Authorization: Bearer <API_KEY>`

## GET /api/v2/accounts
_List account_  
Requires one of the following scopes: `accounts:read`, `accounts:all`, `all:read`, `all:all`

**Params**
- `limit` (query): integer — The number of items to return
- `starting_after` (query): string — Pagination cursor from `next_starting_after`, in `timestamp_created&email` format. Legacy ISO date-time cursor is still supported.
- `search` (query): string
- `status` (query): number enum=[1, 2, 3, -1, -2, -3]
- `provider_code` (query): number enum=[1, 2, 3, 4, 8, 11]
- `tag_ids` (query): string — Filter accounts by tag ids. Returns accounts that have any of the specified tags assigned. You can specify multiple tag ids by separating th
- `tag_ids_all` (query): string — Filter accounts by tag ids with AND logic. Returns only accounts that have all of the specified tags assigned. You can specify multiple tag 
- `include_tags` (query): boolean — Include tags in the response. If true, the response will include the tags assigned to each account.
- `filter` (query): string enum=['ACC_FILTER_PAUSED', 'ACC_FILTER_ERROR', 'ACC_FILTER_NO_CTD', 'ACC_FILTER_PW_ACCOUNTS', 'ACC_FILTER_DFY', 'ACC_FILTER_DFY_SETUP_PENDING', 'ACC_FILTER_W_ACTIVE', 'ACC_FILTER_W_PAUSED', 'ACC_FILTER_W_ERROR'] — The filter to apply to the accounts.
- `sort_by` (query): string enum=['timestamp_created', 'email', 'stat_warmup_score', 'status'] — Column to sort results by.
- `sort_order` (query): string enum=['asc', 'desc'] — Sort direction. Defaults to `desc` when `sort_by` is provided.
- `skip` (query): integer — Number of items to skip for offset-based pagination. Used with `sort_by` when cursor pagination is not available.

**200 response**
- `items` (required): array — The list of Account
  (array of)
    - `email` (required): string — Email address of the account
    - `timestamp_created` (required): string — Timestamp when the account was created
    - `timestamp_updated` (required): string — Timestamp when the account was last updated
    - `first_name` (required): string — First name associated with the account
    - `last_name` (required): string — Last name associated with the account
    - `warmup`: object — Warmup configuration for the account
    - `added_by`: null|string — User ID who added the account
    - `daily_limit`: null|number — Daily email sending limit
    - `daily_limit_max`: null|number — Maximum daily email sending limit for AirMail accounts
    - `warmup_limit_max`: null|number — Maximum daily warmup sending limit for AirMail accounts
    - `modified_by`: null|string — User ID who last modified the account
    - `tracking_domain_name`: null|string — Tracking domain
    - `tracking_domain_status`: null|string — Tracking domain status
    - `status`: number enum=[1, 2, 3, -1, -2, -3] — Current status of the account
    - `enable_slow_ramp`: null|boolean — Whether to enable slow ramp up for sending limits
    - `inbox_placement_test_limit`: null|number — The limit for inbox placement tests
    - `organization` (required): string — Organization ID that owns this account
    - `warmup_status` (required): number enum=[0, 1, -1, -2, -3] — Current warmup status of the account
    - `status_message`: object — Status message for the account
    - `timestamp_warmup_start`: null|string — Timestamp when warmup was started
    - `provider_code` (required): number enum=[1, 2, 3, 4, 8, 11] — Provider code for the account. Please make sure to specify the right provider code, otherwise your account will not work.
    - `setup_pending` (required): boolean — Whether account setup is pending
    - `is_managed_account` (required): boolean — Whether this is a managed account
    - `stat_warmup_score`: null|number — Warmup score for the account
    - `sending_gap`: number — The gap between emails sent from this account in minutes (minimum wait time when used with multiple campaigns)
    - `signature`: null|string — Email signature for the account
    - `reply_to`: null|string — Custom reply-to email address for the account
    - `autofix_failed`: null|boolean — Whether automatic reconnection attempts have failed. null = in progress, true = failed, false = succeeded.
    - `tags`: array|null — Tags associated with the account, set to `include_tags` to populate
- `next_starting_after`: string — The filter for getting the next items after this one, this could either be a UUID, a timestamp, on an email depending on the specific API

## POST /api/v2/accounts
_Create account_  
Requires one of the following scopes: `accounts:create`, `accounts:all`, `all:create`, `all:all`

**Body**
- `email` (required): string — Email address of the account
- `first_name` (required): string — First name associated with the account
- `last_name` (required): string — Last name associated with the account
- `warmup`: object — Warmup configuration for the account
  - `limit`: number — Email sending limit for the account
  - `advanced`: object — Advanced settings for the account
    - `warm_ctd`: boolean — Whether the account is in warm CTD mode
    - `open_rate`: number — Email open rate for the account
    - `important_rate`: number — Important email rate for the account
    - `read_emulation`: boolean — Whether read emulation is enabled
    - `spam_save_rate`: number — Spam save rate for the account
    - `weekday_only`: boolean — Whether to send emails only on weekdays
  - `warmup_custom_ftag`: string — Custom tag for the account
  - `increment`: string enum=['disabled', '0', '1', '2', '3', '4'] — Daily increment added to the sending limit, starting from 0, until the full daily limit is reached (slow ramp). Gradually increases sending ...
  - `reply_rate`: number — Reply rate for the account
- `daily_limit`: number|null — Daily email sending limit
- `tracking_domain_name`: string|null — Tracking domain
- `tracking_domain_status`: string|null — Tracking domain status
- `enable_slow_ramp`: boolean|null — Whether to enable slow ramp up for sending limits
- `inbox_placement_test_limit`: number|null — The limit for inbox placement tests
- `provider_code` (required): number enum=[1, 2, 3, 4, 8, 11] — Provider code for the account. Please make sure to specify the right provider code, otherwise your account will not work.
- `sending_gap`: number — The gap between emails sent from this account in minutes (minimum wait time when used with multiple campaigns)
- `signature`: string|null — Email signature for the account
- `reply_to`: string
- `imap_username` (required): string
- `imap_password` (required): string
- `imap_host` (required): string
- `imap_port` (required): number
- `smtp_username` (required): string
- `smtp_password` (required): string
- `smtp_host` (required): string
- `smtp_port` (required): number
- `warmup_custom_ftag`: string
- `skip_cname_check`: boolean

**200 response**
- `email` (required): string — Email address of the account
- `timestamp_created` (required): string — Timestamp when the account was created
- `timestamp_updated` (required): string — Timestamp when the account was last updated
- `first_name` (required): string — First name associated with the account
- `last_name` (required): string — Last name associated with the account
- `warmup`: object — Warmup configuration for the account
  - `limit`: number — Email sending limit for the account
  - `advanced`: object — Advanced settings for the account
    - `warm_ctd`: boolean — Whether the account is in warm CTD mode
    - `open_rate`: number — Email open rate for the account
    - `important_rate`: number — Important email rate for the account
    - `read_emulation`: boolean — Whether read emulation is enabled
    - `spam_save_rate`: number — Spam save rate for the account
    - `weekday_only`: boolean — Whether to send emails only on weekdays
  - `warmup_custom_ftag`: string — Custom tag for the account
  - `increment`: string enum=['disabled', '0', '1', '2', '3', '4'] — Daily increment added to the sending limit, starting from 0, until the full daily limit is reached (slow ramp). Gradually increases sending ...
  - `reply_rate`: number — Reply rate for the account
- `added_by`: null|string — User ID who added the account
- `daily_limit`: null|number — Daily email sending limit
- `daily_limit_max`: null|number — Maximum daily email sending limit for AirMail accounts
- `warmup_limit_max`: null|number — Maximum daily warmup sending limit for AirMail accounts
- `modified_by`: null|string — User ID who last modified the account
- `tracking_domain_name`: null|string — Tracking domain
- `tracking_domain_status`: null|string — Tracking domain status
- `status`: number enum=[1, 2, 3, -1, -2, -3] — Current status of the account
- `enable_slow_ramp`: null|boolean — Whether to enable slow ramp up for sending limits
- `inbox_placement_test_limit`: null|number — The limit for inbox placement tests
- `organization` (required): string — Organization ID that owns this account
- `warmup_status` (required): number enum=[0, 1, -1, -2, -3] — Current warmup status of the account
- `status_message`: object — Status message for the account
  - `code`: string
  - `command`: string
  - `response`: string
  - `e_message`: string
  - `responseCode`: number
- `timestamp_warmup_start`: null|string — Timestamp when warmup was started
- `provider_code` (required): number enum=[1, 2, 3, 4, 8, 11] — Provider code for the account. Please make sure to specify the right provider code, otherwise your account will not work.
- `setup_pending` (required): boolean — Whether account setup is pending
- `is_managed_account` (required): boolean — Whether this is a managed account
- `stat_warmup_score`: null|number — Warmup score for the account
- `sending_gap`: number — The gap between emails sent from this account in minutes (minimum wait time when used with multiple campaigns)
- `signature`: null|string — Email signature for the account
- `reply_to`: null|string — Custom reply-to email address for the account
- `autofix_failed`: null|boolean — Whether automatic reconnection attempts have failed. null = in progress, true = failed, false = succeeded.

## GET /api/v2/accounts/{email}
_Get account_  
Requires one of the following scopes: `accounts:read`, `accounts:all`, `all:read`, `all:all`

**Params**
- `email` (path): string — The email of the account to get

**200 response**
- `email` (required): string — Email address of the account
- `timestamp_created` (required): string — Timestamp when the account was created
- `timestamp_updated` (required): string — Timestamp when the account was last updated
- `first_name` (required): string — First name associated with the account
- `last_name` (required): string — Last name associated with the account
- `warmup`: object — Warmup configuration for the account
  - `limit`: number — Email sending limit for the account
  - `advanced`: object — Advanced settings for the account
    - `warm_ctd`: boolean — Whether the account is in warm CTD mode
    - `open_rate`: number — Email open rate for the account
    - `important_rate`: number — Important email rate for the account
    - `read_emulation`: boolean — Whether read emulation is enabled
    - `spam_save_rate`: number — Spam save rate for the account
    - `weekday_only`: boolean — Whether to send emails only on weekdays
  - `warmup_custom_ftag`: string — Custom tag for the account
  - `increment`: string enum=['disabled', '0', '1', '2', '3', '4'] — Daily increment added to the sending limit, starting from 0, until the full daily limit is reached (slow ramp). Gradually increases sending ...
  - `reply_rate`: number — Reply rate for the account
- `added_by`: null|string — User ID who added the account
- `daily_limit`: null|number — Daily email sending limit
- `daily_limit_max`: null|number — Maximum daily email sending limit for AirMail accounts
- `warmup_limit_max`: null|number — Maximum daily warmup sending limit for AirMail accounts
- `modified_by`: null|string — User ID who last modified the account
- `tracking_domain_name`: null|string — Tracking domain
- `tracking_domain_status`: null|string — Tracking domain status
- `status`: number enum=[1, 2, 3, -1, -2, -3] — Current status of the account
- `enable_slow_ramp`: null|boolean — Whether to enable slow ramp up for sending limits
- `inbox_placement_test_limit`: null|number — The limit for inbox placement tests
- `organization` (required): string — Organization ID that owns this account
- `warmup_status` (required): number enum=[0, 1, -1, -2, -3] — Current warmup status of the account
- `status_message`: object — Status message for the account
  - `code`: string
  - `command`: string
  - `response`: string
  - `e_message`: string
  - `responseCode`: number
- `timestamp_warmup_start`: null|string — Timestamp when warmup was started
- `provider_code` (required): number enum=[1, 2, 3, 4, 8, 11] — Provider code for the account. Please make sure to specify the right provider code, otherwise your account will not work.
- `setup_pending` (required): boolean — Whether account setup is pending
- `is_managed_account` (required): boolean — Whether this is a managed account
- `stat_warmup_score`: null|number — Warmup score for the account
- `sending_gap`: number — The gap between emails sent from this account in minutes (minimum wait time when used with multiple campaigns)
- `signature`: null|string — Email signature for the account
- `reply_to`: null|string — Custom reply-to email address for the account
- `autofix_failed`: null|boolean — Whether automatic reconnection attempts have failed. null = in progress, true = failed, false = succeeded.

## PATCH /api/v2/accounts/{email}
_Patch account_  
Requires one of the following scopes: `accounts:update`, `accounts:all`, `all:update`, `all:all`

**Params**
- `email` (path): string — The email of the account to update

**Body**
- `first_name`: string — First name associated with the account
- `last_name`: string — Last name associated with the account
- `warmup`: object — Warmup configuration for the account
  - `limit`: number — Email sending limit for the account
  - `advanced`: object — Advanced settings for the account
    - `warm_ctd`: boolean — Whether the account is in warm CTD mode
    - `open_rate`: number — Email open rate for the account
    - `important_rate`: number — Important email rate for the account
    - `read_emulation`: boolean — Whether read emulation is enabled
    - `spam_save_rate`: number — Spam save rate for the account
    - `weekday_only`: boolean — Whether to send emails only on weekdays
  - `warmup_custom_ftag`: string — Custom tag for the account
  - `increment`: string enum=['disabled', '0', '1', '2', '3', '4'] — Daily increment added to the sending limit, starting from 0, until the full daily limit is reached (slow ramp). Gradually increases sending ...
  - `reply_rate`: number — Reply rate for the account
- `daily_limit`: number|null — Daily email sending limit
- `tracking_domain_name`: string|null — Tracking domain
- `tracking_domain_status`: string|null — Tracking domain status
- `enable_slow_ramp`: boolean|null — Whether to enable slow ramp up for sending limits
- `inbox_placement_test_limit`: number|null — The limit for inbox placement tests
- `sending_gap`: number — The gap between emails sent from this account in minutes (minimum wait time when used with multiple campaigns)
- `signature`: string|null — Email signature for the account
- `reply_to`: string|null — Custom reply-to email address for the account
- `skip_cname_check`: boolean
- `remove_tracking_domain`: boolean

**200 response**
- `email` (required): string — Email address of the account
- `timestamp_created` (required): string — Timestamp when the account was created
- `timestamp_updated` (required): string — Timestamp when the account was last updated
- `first_name` (required): string — First name associated with the account
- `last_name` (required): string — Last name associated with the account
- `warmup`: object — Warmup configuration for the account
  - `limit`: number — Email sending limit for the account
  - `advanced`: object — Advanced settings for the account
    - `warm_ctd`: boolean — Whether the account is in warm CTD mode
    - `open_rate`: number — Email open rate for the account
    - `important_rate`: number — Important email rate for the account
    - `read_emulation`: boolean — Whether read emulation is enabled
    - `spam_save_rate`: number — Spam save rate for the account
    - `weekday_only`: boolean — Whether to send emails only on weekdays
  - `warmup_custom_ftag`: string — Custom tag for the account
  - `increment`: string enum=['disabled', '0', '1', '2', '3', '4'] — Daily increment added to the sending limit, starting from 0, until the full daily limit is reached (slow ramp). Gradually increases sending ...
  - `reply_rate`: number — Reply rate for the account
- `added_by`: null|string — User ID who added the account
- `daily_limit`: null|number — Daily email sending limit
- `daily_limit_max`: null|number — Maximum daily email sending limit for AirMail accounts
- `warmup_limit_max`: null|number — Maximum daily warmup sending limit for AirMail accounts
- `modified_by`: null|string — User ID who last modified the account
- `tracking_domain_name`: null|string — Tracking domain
- `tracking_domain_status`: null|string — Tracking domain status
- `status`: number enum=[1, 2, 3, -1, -2, -3] — Current status of the account
- `enable_slow_ramp`: null|boolean — Whether to enable slow ramp up for sending limits
- `inbox_placement_test_limit`: null|number — The limit for inbox placement tests
- `organization` (required): string — Organization ID that owns this account
- `warmup_status` (required): number enum=[0, 1, -1, -2, -3] — Current warmup status of the account
- `status_message`: object — Status message for the account
  - `code`: string
  - `command`: string
  - `response`: string
  - `e_message`: string
  - `responseCode`: number
- `timestamp_warmup_start`: null|string — Timestamp when warmup was started
- `provider_code` (required): number enum=[1, 2, 3, 4, 8, 11] — Provider code for the account. Please make sure to specify the right provider code, otherwise your account will not work.
- `setup_pending` (required): boolean — Whether account setup is pending
- `is_managed_account` (required): boolean — Whether this is a managed account
- `stat_warmup_score`: null|number — Warmup score for the account
- `sending_gap`: number — The gap between emails sent from this account in minutes (minimum wait time when used with multiple campaigns)
- `signature`: null|string — Email signature for the account
- `reply_to`: null|string — Custom reply-to email address for the account
- `autofix_failed`: null|boolean — Whether automatic reconnection attempts have failed. null = in progress, true = failed, false = succeeded.

## POST /api/v2/accounts/warmup/enable
_Enable warmup for accounts_  
Initiates a background job to enable warmup for the specified accounts. The response will contain the initial background job object. You can monitor the job's progress by polling the `GET: /api/v2/background-jobs/:id` endpoint.

**Body**
- `emails`: array — List of emails to enable warmup accounts for. The emails should be attached to accounts in your workspace.
  (array of)
- `include_all_emails`: boolean — If true, it will enable warmup to all accounts
- `excluded_emails`: array — List of emails to exclude when `include_all_emails` is `true`.
  (array of)
- `filter`: object|null — Optional filter to apply when `include_all_emails` is `true`. Can contain tag_id or other filter criteria.
  - `tag_id`: string — The ID of the tag to filter accounts by.
  - `filter`: string|null enum=['ACC_FILTER_PAUSED', 'ACC_FILTER_ERROR', 'ACC_FILTER_NO_CTD', 'ACC_FILTER_PW_ACCOUNTS', 'ACC_FILTER_DFY', 'ACC_FILTER_DFY_SETUP_PENDING', 'ACC_FILTER_W_ACTIVE', 'ACC_FILTER_W_PAUSED', 'ACC_FILTER_W_ERROR', None] — The filter to apply to the accounts.
- `search`: string — Optional search query to filter accounts when `include_all_emails` is `true`.

**200 response**
- `id` (required): string — Unique identifier for the background job
- `workspace_id` (required): string — Workspace ID
- `user_id`: null|string — The id of the user that triggered the action that created the job
- `type` (required): string enum=['move-leads', 'import-leads', 'export-leads', 'update-warmup-accounts', 'rename-variable', 'broadcast-ai-generate', 'broadcast-website-scrape', 'import-subscribers-from-crm', 'resync-subscriber-crm-tags', 'journey-ai-build'] — Type of background job
- `entity_id`: null|string — The id of the entity that the job is related to
- `entity_type`: string enum=['list', 'campaign', 'workspace', 'broadcast', 'subscriber-group-sync', 'subscriber-group', 'journey'] — Type of entity
- `data`: object — Data about the job, used to store any additional information we need to process the job
  - `moved_lead_emails`: array — For `move-leads` jobs, up to the first 10,000 email addresses of leads that actually moved or copied to the destination after all filters we...
    (array of)
- `progress` (required): number — Progress of the job as a percentage (from 0 to 100)
- `status` (required): string enum=['pending', 'in-progress', 'success', 'failed', 'draining', 'paused', 'cancelled'] — Job status
- `created_at` (required): string — Timestamp when the job was created
- `updated_at` (required): string — Timestamp when the job was last updated

## POST /api/v2/accounts/warmup/disable
_Disable warmup for accounts_  
Initiates a background job to disable warmup for the specified accounts. The response will contain the initial background job object. You can monitor the job's progress by polling the `GET: /api/v2/background-jobs/:id` endpoint.

**Body**
- `emails`: array — List of emails to disable warmup accounts for. The emails should be attached to accounts in your workspace.
  (array of)
- `include_all_emails`: boolean — If true, it will disable warmup to all accounts
- `excluded_emails`: array — List of emails to exclude when `include_all_emails` is `true`.
  (array of)
- `filter`: object|null — Optional filter to apply when `include_all_emails` is `true`. Can contain tag_id or other filter criteria.
  - `tag_id`: string — The ID of the tag to filter accounts by.
  - `filter`: string|null enum=['ACC_FILTER_PAUSED', 'ACC_FILTER_ERROR', 'ACC_FILTER_NO_CTD', 'ACC_FILTER_PW_ACCOUNTS', 'ACC_FILTER_DFY', 'ACC_FILTER_DFY_SETUP_PENDING', 'ACC_FILTER_W_ACTIVE', 'ACC_FILTER_W_PAUSED', 'ACC_FILTER_W_ERROR', None] — The filter to apply to the accounts.
- `search`: string — Optional search query to filter accounts when `include_all_emails` is `true`.

**200 response**
- `id` (required): string — Unique identifier for the background job
- `workspace_id` (required): string — Workspace ID
- `user_id`: null|string — The id of the user that triggered the action that created the job
- `type` (required): string enum=['move-leads', 'import-leads', 'export-leads', 'update-warmup-accounts', 'rename-variable', 'broadcast-ai-generate', 'broadcast-website-scrape', 'import-subscribers-from-crm', 'resync-subscriber-crm-tags', 'journey-ai-build'] — Type of background job
- `entity_id`: null|string — The id of the entity that the job is related to
- `entity_type`: string enum=['list', 'campaign', 'workspace', 'broadcast', 'subscriber-group-sync', 'subscriber-group', 'journey'] — Type of entity
- `data`: object — Data about the job, used to store any additional information we need to process the job
  - `moved_lead_emails`: array — For `move-leads` jobs, up to the first 10,000 email addresses of leads that actually moved or copied to the destination after all filters we...
    (array of)
- `progress` (required): number — Progress of the job as a percentage (from 0 to 100)
- `status` (required): string enum=['pending', 'in-progress', 'success', 'failed', 'draining', 'paused', 'cancelled'] — Job status
- `created_at` (required): string — Timestamp when the job was created
- `updated_at` (required): string — Timestamp when the job was last updated

## POST /api/v2/accounts/warmup-analytics
_Get warmup analytics_  
Requires one of the following scopes: `accounts:read`, `accounts:all`, `all:read`, `all:all`

**Body**
- `emails` (required): array — List of emails to get warmup analytics for. The emails should be attached to accounts in your workspace.
  (array of)

**200 response**
- `email_date_data`: object
- `aggregate_data`: object

## POST /api/v2/accounts/test/vitals
_Test account vitals_  
Requires one of the following scopes: `accounts:read`, `accounts:all`, `all:read`, `all:all`

**Body**
- `accounts`: array
  (array of)

**200 response**
- `status`: string
- `success_list`: array
  (array of)
    - `domain`: string
    - `allPass`: boolean
    - `mx`: boolean
    - `spf`: boolean
    - `dkim`: boolean
    - `dmarc`: boolean
    - `indeterminate`: array — Records that could not be verified because the DNS resolver kept failing. They are reported as not passing, but the records may exist; re-ru...
- `failure_list`: array
  (array of)
    - `domain`: string
    - `allPass`: boolean
    - `mx`: boolean
    - `spf`: boolean
    - `dkim`: boolean
    - `dmarc`: boolean
    - `indeterminate`: array — Records that could not be verified because the DNS resolver kept failing. They are reported as not passing, but the records may exist; re-ru...

## GET /api/v2/accounts/analytics/daily
_Get daily account analytics_  
Get daily account analytics showing the number of emails sent per day for each email account. Useful for tracking daily sending activity across your accounts.

**Params**
- `start_date` (query): string — Start date for the analytics period. Defaults to a 30-day window ending at end_date. The maximum range is 31 days.
- `end_date` (query): string — End date for the analytics period. Defaults to the current date.
- `emails` (query): array — Email accounts to include. This filter is required and accepts at most 200 unique accounts.

**200 response**
(array of)
  - `date` (required): string — The date of the analytics entry, in YYYY-MM-DD format
  - `email_account` (required): string — The email account that sent the emails
  - `sent` (required): integer — The total number of campaign emails sent on this date by this account, including emails for subsequences
  - `bounced` (required): integer — The number of emails that bounced on this date for this account for campaigns - including subsequences
  - `contacted` (required): integer — The total number of unique contacts who received an email on this date from this account
  - `new_leads_contacted` (required): integer — The total number of new leads contacted on this date from this account
  - `opened` (required): integer — The total number of opened emails on this date for this account
  - `unique_opened` (required): integer — The total number of unique opened emails on this date for this account
  - `replies` (required): integer — The total number of replies received on this date for this account
  - `unique_replies` (required): integer — The total number of unique replies received on this date for this account
  - `replies_automatic` (required): integer — The total number of automatic replies detected on this date for this account
  - `unique_replies_automatic` (required): integer — The total number of unique automatic replies detected on this date for this account
  - `clicks` (required): integer — The total number of links clicked on this date for this account
  - `unique_clicks` (required): integer — The total number of unique links clicked on this date for this account. Unique meaning from unique leads, not unique links

## POST /api/v2/accounts/{email}/pause
_Pause an account_  
Requires one of the following scopes: `accounts:update`, `accounts:all`, `all:update`, `all:all`

**Params**
- `email` (path): string — The email of the account to pause

**200 response**
- `email` (required): string — Email address of the account
- `timestamp_created` (required): string — Timestamp when the account was created
- `timestamp_updated` (required): string — Timestamp when the account was last updated
- `first_name` (required): string — First name associated with the account
- `last_name` (required): string — Last name associated with the account
- `warmup`: object — Warmup configuration for the account
  - `limit`: number — Email sending limit for the account
  - `advanced`: object — Advanced settings for the account
    - `warm_ctd`: boolean — Whether the account is in warm CTD mode
    - `open_rate`: number — Email open rate for the account
    - `important_rate`: number — Important email rate for the account
    - `read_emulation`: boolean — Whether read emulation is enabled
    - `spam_save_rate`: number — Spam save rate for the account
    - `weekday_only`: boolean — Whether to send emails only on weekdays
  - `warmup_custom_ftag`: string — Custom tag for the account
  - `increment`: string enum=['disabled', '0', '1', '2', '3', '4'] — Daily increment added to the sending limit, starting from 0, until the full daily limit is reached (slow ramp). Gradually increases sending ...
  - `reply_rate`: number — Reply rate for the account
- `added_by`: null|string — User ID who added the account
- `daily_limit`: null|number — Daily email sending limit
- `daily_limit_max`: null|number — Maximum daily email sending limit for AirMail accounts
- `warmup_limit_max`: null|number — Maximum daily warmup sending limit for AirMail accounts
- `modified_by`: null|string — User ID who last modified the account
- `tracking_domain_name`: null|string — Tracking domain
- `tracking_domain_status`: null|string — Tracking domain status
- `status`: number enum=[1, 2, 3, -1, -2, -3] — Current status of the account
- `enable_slow_ramp`: null|boolean — Whether to enable slow ramp up for sending limits
- `inbox_placement_test_limit`: null|number — The limit for inbox placement tests
- `organization` (required): string — Organization ID that owns this account
- `warmup_status` (required): number enum=[0, 1, -1, -2, -3] — Current warmup status of the account
- `status_message`: object — Status message for the account
  - `code`: string
  - `command`: string
  - `response`: string
  - `e_message`: string
  - `responseCode`: number
- `timestamp_warmup_start`: null|string — Timestamp when warmup was started
- `provider_code` (required): number enum=[1, 2, 3, 4, 8, 11] — Provider code for the account. Please make sure to specify the right provider code, otherwise your account will not work.
- `setup_pending` (required): boolean — Whether account setup is pending
- `is_managed_account` (required): boolean — Whether this is a managed account
- `stat_warmup_score`: null|number — Warmup score for the account
- `sending_gap`: number — The gap between emails sent from this account in minutes (minimum wait time when used with multiple campaigns)
- `signature`: null|string — Email signature for the account
- `reply_to`: null|string — Custom reply-to email address for the account
- `autofix_failed`: null|boolean — Whether automatic reconnection attempts have failed. null = in progress, true = failed, false = succeeded.

## POST /api/v2/accounts/{email}/resume
_Resume a paused account_  
Requires one of the following scopes: `accounts:update`, `accounts:all`, `all:update`, `all:all`

**Params**
- `email` (path): string — Account email

**200 response**
- `email` (required): string — Email address of the account
- `timestamp_created` (required): string — Timestamp when the account was created
- `timestamp_updated` (required): string — Timestamp when the account was last updated
- `first_name` (required): string — First name associated with the account
- `last_name` (required): string — Last name associated with the account
- `warmup`: object — Warmup configuration for the account
  - `limit`: number — Email sending limit for the account
  - `advanced`: object — Advanced settings for the account
    - `warm_ctd`: boolean — Whether the account is in warm CTD mode
    - `open_rate`: number — Email open rate for the account
    - `important_rate`: number — Important email rate for the account
    - `read_emulation`: boolean — Whether read emulation is enabled
    - `spam_save_rate`: number — Spam save rate for the account
    - `weekday_only`: boolean — Whether to send emails only on weekdays
  - `warmup_custom_ftag`: string — Custom tag for the account
  - `increment`: string enum=['disabled', '0', '1', '2', '3', '4'] — Daily increment added to the sending limit, starting from 0, until the full daily limit is reached (slow ramp). Gradually increases sending ...
  - `reply_rate`: number — Reply rate for the account
- `added_by`: null|string — User ID who added the account
- `daily_limit`: null|number — Daily email sending limit
- `daily_limit_max`: null|number — Maximum daily email sending limit for AirMail accounts
- `warmup_limit_max`: null|number — Maximum daily warmup sending limit for AirMail accounts
- `modified_by`: null|string — User ID who last modified the account
- `tracking_domain_name`: null|string — Tracking domain
- `tracking_domain_status`: null|string — Tracking domain status
- `status`: number enum=[1, 2, 3, -1, -2, -3] — Current status of the account
- `enable_slow_ramp`: null|boolean — Whether to enable slow ramp up for sending limits
- `inbox_placement_test_limit`: null|number — The limit for inbox placement tests
- `organization` (required): string — Organization ID that owns this account
- `warmup_status` (required): number enum=[0, 1, -1, -2, -3] — Current warmup status of the account
- `status_message`: object — Status message for the account
  - `code`: string
  - `command`: string
  - `response`: string
  - `e_message`: string
  - `responseCode`: number
- `timestamp_warmup_start`: null|string — Timestamp when warmup was started
- `provider_code` (required): number enum=[1, 2, 3, 4, 8, 11] — Provider code for the account. Please make sure to specify the right provider code, otherwise your account will not work.
- `setup_pending` (required): boolean — Whether account setup is pending
- `is_managed_account` (required): boolean — Whether this is a managed account
- `stat_warmup_score`: null|number — Warmup score for the account
- `sending_gap`: number — The gap between emails sent from this account in minutes (minimum wait time when used with multiple campaigns)
- `signature`: null|string — Email signature for the account
- `reply_to`: null|string — Custom reply-to email address for the account
- `autofix_failed`: null|boolean — Whether automatic reconnection attempts have failed. null = in progress, true = failed, false = succeeded.

## POST /api/v2/campaigns
_Create campaign_  
Requires one of the following scopes: `campaigns:create`, `campaigns:all`, `all:create`, `all:all`

**Body**
- `name` (required): string — Name of the campaign
- `pl_value`: number|null — Value of every positive lead
- `is_evergreen`: boolean|null — Whether the campaign is evergreen
- `campaign_schedule` (required): object — Campaign schedule
  - `start_date`: string|null — Start date in YYYY-MM-DD format. Uses the campaign's timezone.
  - `end_date`: string|null — End date in YYYY-MM-DD format. Uses the campaign's timezone.
  - `schedules` (required): array
    (array of)
      - `name` (required): string
      - `timing` (required): object
      - `days` (required): object
      - `timezone` (required): string enum=['Etc/GMT+12', 'Etc/GMT+11', 'Etc/GMT+10', 'America/Anchorage', 'America/Dawson', 'America/Creston', 'America/Chihuahua', 'America/Boise', 'America/Belize', 'America/Chicago', 'America/Bahia_Banderas', 'America/Regina']
- `sequences`: array — List of sequences (the actual email copy). Even though this field is an array, only the first element is used, so please provide only one ar...
  (array of)
    - `steps` (required): array — The steps of the sequence. Each sequence needs at least one step.
      (array of)
        - `type` (required): string enum=['email'] — Type of step. This has to be 'email' always - it's the only supported type for now
        - `delay` (required): number — The delay value before sending the NEXT email. The unit is determined by the delay_unit field (defaults to days). The total delay cannot exc...
        - `delay_unit`: string enum=['minutes', 'hours', 'days'] — The unit of time for the delay value (minutes, hours, or days). Defaults to days for backward compatibility.
        - `pre_delay`: number — The delay value before sending the FIRST email in a subsequence. **Only applicable to subsequences** - this field is ignored for regular cam...
        - `pre_delay_unit`: string enum=['minutes', 'hours', 'days'] — The unit of time for the pre_delay value (minutes, hours, or days). **Only applicable to subsequences** - this field is ignored for regular ...
        - `variants` (required): array — Email variants for this step. Each step needs at least one variant.
- `email_gap`: number|null — The gap between emails in minutes
- `random_wait_max`: number|null — The maximum random wait time in minutes
- `text_only`: boolean|null — Whether the campaign is text only
- `first_email_text_only`: boolean|null — Whether the campaign is send the first email as a text only
- `email_list`: array — List of accounts to use for sending emails
  (array of)
- `daily_limit`: number|null — The daily limit for sending emails
- `stop_on_reply`: boolean|null — Whether to stop the campaign on reply
- `email_tag_list`: array — List of tags to use for sending emails
  (array of)
- `link_tracking`: boolean|null — Whether to track links in emails
- `open_tracking`: boolean — Whether to track opens in emails
- `stop_on_auto_reply`: boolean|null — Whether to stop the campaign on auto reply
- `daily_max_leads`: integer|null — The daily maximum new leads to contact
- `prioritize_new_leads`: boolean|null — Whether to prioritize new leads
- `auto_variant_select`: object|null — Auto variant select settings
  - `trigger` (required): string enum=['reply_rate', 'click_rate', 'open_rate']
- `match_lead_esp`: boolean|null — Whether to match leads by ESP
- `stop_for_company`: boolean|null — Whether to stop the campaign for the entire company(domain) when a lead replies
- `insert_unsubscribe_header`: boolean|null — Whether to insert an unsubscribe header in emails
- `allow_risky_contacts`: boolean|null — Whether to allow risky contacts
- `disable_bounce_protect`: boolean|null — Whether to disable bounce protection
- `limit_emails_per_company_override`: object|null — Overrides the workspace-wide limit emails per company setting for this campaign.
  - `mode` (required): string enum=['custom', 'disabled']
  - `daily_limit`: number
  - `scope`: string enum=['per_campaign', 'across_workspace']
- `cc_list`: array — List of accounts to CC on emails
  (array of)
- `bcc_list`: array — List of accounts to BCC on emails
  (array of)
- `owned_by`: string|null — Owner ID
- `ai_sdr_id`: string|null — AI Sales Agent ID that created this campaign
- `provider_routing_rules`: array — Auto variant select settings
  (array of)
    - `action`: string enum=['send', 'do_not_send']
    - `recipient_esp`: array
      (array of)
    - `sender_esp`: array
      (array of)

**200 response**
- `id` (required): string — Unique identifier for the campaign
- `name` (required): string — Name of the campaign
- `pl_value`: null|number — Value of every positive lead
- `status` (required): number enum=[-99, -1, -2, 0, 1, 2, 3, 4] — Campaign Status
- `is_evergreen`: null|boolean — Whether the campaign is evergreen
- `campaign_schedule` (required): object — Campaign schedule
  - `start_date`: null|string — Start date in YYYY-MM-DD format. Uses the campaign's timezone.
  - `end_date`: null|string — End date in YYYY-MM-DD format. Uses the campaign's timezone.
  - `schedules` (required): array
    (array of)
      - `name` (required): string
      - `timing` (required): object
      - `days` (required): object
      - `timezone` (required): string enum=['Etc/GMT+12', 'Etc/GMT+11', 'Etc/GMT+10', 'America/Anchorage', 'America/Dawson', 'America/Creston', 'America/Chihuahua', 'America/Boise', 'America/Belize', 'America/Chicago', 'America/Bahia_Banderas', 'America/Regina']
- `sequences`: array — List of sequences (the actual email copy). Even though this field is an array, only the first element is used, so please provide only one ar...
  (array of)
    - `steps` (required): array — The steps of the sequence. Each sequence needs at least one step.
- `timestamp_created` (required): string — Timestamp when the campaign was created
- `timestamp_updated` (required): string — Timestamp when the campaign was last updated
- `email_gap`: null|number — The gap between emails in minutes
- `random_wait_max`: null|number — The maximum random wait time in minutes
- `text_only`: null|boolean — Whether the campaign is text only
- `first_email_text_only`: null|boolean — Whether the campaign is send the first email as a text only
- `email_list`: array — List of accounts to use for sending emails
  (array of)
- `daily_limit`: null|number — The daily limit for sending emails
- `stop_on_reply`: null|boolean — Whether to stop the campaign on reply
- `email_tag_list`: array — List of tags to use for sending emails
  (array of)
- `link_tracking`: null|boolean — Whether to track links in emails
- `open_tracking`: boolean — Whether to track opens in emails
- `stop_on_auto_reply`: null|boolean — Whether to stop the campaign on auto reply
- `daily_max_leads`: null|integer — The daily maximum new leads to contact
- `prioritize_new_leads`: null|boolean — Whether to prioritize new leads
- `auto_variant_select`: null|object — Auto variant select settings
  - `trigger` (required): string enum=['reply_rate', 'click_rate', 'open_rate']
- `match_lead_esp`: null|boolean — Whether to match leads by ESP
- `not_sending_status`: null|number enum=[1, 2, 3, 4, 99] — Campaign not sending status
- `stop_for_company`: null|boolean — Whether to stop the campaign for the entire company(domain) when a lead replies
- `core_variables`: null|object — Campaign core variables
- `custom_variables`: null|object — Campaign custom variables
- `insert_unsubscribe_header`: null|boolean — Whether to insert an unsubscribe header in emails
- `allow_risky_contacts`: null|boolean — Whether to allow risky contacts
- `disable_bounce_protect`: null|boolean — Whether to disable bounce protection
- `limit_emails_per_company_override`: null|object — Overrides the workspace-wide limit emails per company setting for this campaign.
  - `mode` (required): string enum=['custom', 'disabled']
  - `daily_limit`: number
  - `scope`: string enum=['per_campaign', 'across_workspace']
- `cc_list`: array — List of accounts to CC on emails
  (array of)
- `bcc_list`: array — List of accounts to BCC on emails
  (array of)
- `organization`: null|string — Organization ID
- `owned_by`: null|string — Owner ID
- `created_by`: null|string — ID of the user who created the campaign
- `ai_sdr_id`: null|string — AI Sales Agent ID that created this campaign
- `provider_routing_rules`: array — Auto variant select settings
  (array of)
    - `action`: string enum=['send', 'do_not_send']
    - `recipient_esp`: array
    - `sender_esp`: array

## GET /api/v2/campaigns/{id}
_Get campaign_  
Requires one of the following scopes: `campaigns:read`, `campaigns:all`, `all:read`, `all:all`

**Params**
- `id` (path): string — The ID of the requested item

**200 response**
- `id` (required): string — Unique identifier for the campaign
- `name` (required): string — Name of the campaign
- `pl_value`: null|number — Value of every positive lead
- `status` (required): number enum=[-99, -1, -2, 0, 1, 2, 3, 4] — Campaign Status
- `is_evergreen`: null|boolean — Whether the campaign is evergreen
- `campaign_schedule` (required): object — Campaign schedule
  - `start_date`: null|string — Start date in YYYY-MM-DD format. Uses the campaign's timezone.
  - `end_date`: null|string — End date in YYYY-MM-DD format. Uses the campaign's timezone.
  - `schedules` (required): array
    (array of)
      - `name` (required): string
      - `timing` (required): object
      - `days` (required): object
      - `timezone` (required): string enum=['Etc/GMT+12', 'Etc/GMT+11', 'Etc/GMT+10', 'America/Anchorage', 'America/Dawson', 'America/Creston', 'America/Chihuahua', 'America/Boise', 'America/Belize', 'America/Chicago', 'America/Bahia_Banderas', 'America/Regina']
- `sequences`: array — List of sequences (the actual email copy). Even though this field is an array, only the first element is used, so please provide only one ar...
  (array of)
    - `steps` (required): array — The steps of the sequence. Each sequence needs at least one step.
- `timestamp_created` (required): string — Timestamp when the campaign was created
- `timestamp_updated` (required): string — Timestamp when the campaign was last updated
- `email_gap`: null|number — The gap between emails in minutes
- `random_wait_max`: null|number — The maximum random wait time in minutes
- `text_only`: null|boolean — Whether the campaign is text only
- `first_email_text_only`: null|boolean — Whether the campaign is send the first email as a text only
- `email_list`: array — List of accounts to use for sending emails
  (array of)
- `daily_limit`: null|number — The daily limit for sending emails
- `stop_on_reply`: null|boolean — Whether to stop the campaign on reply
- `email_tag_list`: array — List of tags to use for sending emails
  (array of)
- `link_tracking`: null|boolean — Whether to track links in emails
- `open_tracking`: boolean — Whether to track opens in emails
- `stop_on_auto_reply`: null|boolean — Whether to stop the campaign on auto reply
- `daily_max_leads`: null|integer — The daily maximum new leads to contact
- `prioritize_new_leads`: null|boolean — Whether to prioritize new leads
- `auto_variant_select`: null|object — Auto variant select settings
  - `trigger` (required): string enum=['reply_rate', 'click_rate', 'open_rate']
- `match_lead_esp`: null|boolean — Whether to match leads by ESP
- `not_sending_status`: null|number enum=[1, 2, 3, 4, 99] — Campaign not sending status
- `stop_for_company`: null|boolean — Whether to stop the campaign for the entire company(domain) when a lead replies
- `core_variables`: null|object — Campaign core variables
- `custom_variables`: null|object — Campaign custom variables
- `insert_unsubscribe_header`: null|boolean — Whether to insert an unsubscribe header in emails
- `allow_risky_contacts`: null|boolean — Whether to allow risky contacts
- `disable_bounce_protect`: null|boolean — Whether to disable bounce protection
- `limit_emails_per_company_override`: null|object — Overrides the workspace-wide limit emails per company setting for this campaign.
  - `mode` (required): string enum=['custom', 'disabled']
  - `daily_limit`: number
  - `scope`: string enum=['per_campaign', 'across_workspace']
- `cc_list`: array — List of accounts to CC on emails
  (array of)
- `bcc_list`: array — List of accounts to BCC on emails
  (array of)
- `organization`: null|string — Organization ID
- `owned_by`: null|string — Owner ID
- `created_by`: null|string — ID of the user who created the campaign
- `ai_sdr_id`: null|string — AI Sales Agent ID that created this campaign
- `provider_routing_rules`: array — Auto variant select settings
  (array of)
    - `action`: string enum=['send', 'do_not_send']
    - `recipient_esp`: array
    - `sender_esp`: array

## PATCH /api/v2/campaigns/{id}
_Patch campaign_  
Requires one of the following scopes: `campaigns:update`, `campaigns:all`, `all:update`, `all:all`

**Params**
- `id` (path): string — The ID of the item to update

**Body**
- `name`: string — Name of the campaign
- `pl_value`: number|null — Value of every positive lead
- `is_evergreen`: boolean|null — Whether the campaign is evergreen
- `campaign_schedule`: object — Campaign schedule
  - `start_date`: string|null — Start date in YYYY-MM-DD format. Uses the campaign's timezone.
  - `end_date`: string|null — End date in YYYY-MM-DD format. Uses the campaign's timezone.
  - `schedules` (required): array
    (array of)
      - `name` (required): string
      - `timing` (required): object
      - `days` (required): object
      - `timezone` (required): string enum=['Etc/GMT+12', 'Etc/GMT+11', 'Etc/GMT+10', 'America/Anchorage', 'America/Dawson', 'America/Creston', 'America/Chihuahua', 'America/Boise', 'America/Belize', 'America/Chicago', 'America/Bahia_Banderas', 'America/Regina']
- `sequences`: array — List of sequences (the actual email copy). Even though this field is an array, only the first element is used, so please provide only one ar...
  (array of)
    - `steps` (required): array — The steps of the sequence. Each sequence needs at least one step.
      (array of)
        - `type` (required): string enum=['email'] — Type of step. This has to be 'email' always - it's the only supported type for now
        - `delay` (required): number — The delay value before sending the NEXT email. The unit is determined by the delay_unit field (defaults to days). The total delay cannot exc...
        - `delay_unit`: string enum=['minutes', 'hours', 'days'] — The unit of time for the delay value (minutes, hours, or days). Defaults to days for backward compatibility.
        - `pre_delay`: number — The delay value before sending the FIRST email in a subsequence. **Only applicable to subsequences** - this field is ignored for regular cam...
        - `pre_delay_unit`: string enum=['minutes', 'hours', 'days'] — The unit of time for the pre_delay value (minutes, hours, or days). **Only applicable to subsequences** - this field is ignored for regular ...
        - `variants` (required): array — Email variants for this step. Each step needs at least one variant.
- `email_gap`: number|null — The gap between emails in minutes
- `random_wait_max`: number|null — The maximum random wait time in minutes
- `text_only`: boolean|null — Whether the campaign is text only
- `first_email_text_only`: boolean|null — Whether the campaign is send the first email as a text only
- `email_list`: array — List of accounts to use for sending emails
  (array of)
- `daily_limit`: number|null — The daily limit for sending emails
- `stop_on_reply`: boolean|null — Whether to stop the campaign on reply
- `email_tag_list`: array — List of tags to use for sending emails
  (array of)
- `link_tracking`: boolean|null — Whether to track links in emails
- `open_tracking`: boolean — Whether to track opens in emails
- `stop_on_auto_reply`: boolean|null — Whether to stop the campaign on auto reply
- `daily_max_leads`: integer|null — The daily maximum new leads to contact
- `prioritize_new_leads`: boolean|null — Whether to prioritize new leads
- `auto_variant_select`: object|null — Auto variant select settings
  - `trigger` (required): string enum=['reply_rate', 'click_rate', 'open_rate']
- `match_lead_esp`: boolean|null — Whether to match leads by ESP
- `stop_for_company`: boolean|null — Whether to stop the campaign for the entire company(domain) when a lead replies
- `insert_unsubscribe_header`: boolean|null — Whether to insert an unsubscribe header in emails
- `allow_risky_contacts`: boolean|null — Whether to allow risky contacts
- `disable_bounce_protect`: boolean|null — Whether to disable bounce protection
- `limit_emails_per_company_override`: object|null — Overrides the workspace-wide limit emails per company setting for this campaign.
  - `mode` (required): string enum=['custom', 'disabled']
  - `daily_limit`: number
  - `scope`: string enum=['per_campaign', 'across_workspace']
- `cc_list`: array — List of accounts to CC on emails
  (array of)
- `bcc_list`: array — List of accounts to BCC on emails
  (array of)
- `owned_by`: string|null — Owner ID
- `provider_routing_rules`: array — Auto variant select settings
  (array of)
    - `action`: string enum=['send', 'do_not_send']
    - `recipient_esp`: array
      (array of)
    - `sender_esp`: array
      (array of)

**200 response**
- `id` (required): string — Unique identifier for the campaign
- `name` (required): string — Name of the campaign
- `pl_value`: null|number — Value of every positive lead
- `status` (required): number enum=[-99, -1, -2, 0, 1, 2, 3, 4] — Campaign Status
- `is_evergreen`: null|boolean — Whether the campaign is evergreen
- `campaign_schedule` (required): object — Campaign schedule
  - `start_date`: null|string — Start date in YYYY-MM-DD format. Uses the campaign's timezone.
  - `end_date`: null|string — End date in YYYY-MM-DD format. Uses the campaign's timezone.
  - `schedules` (required): array
    (array of)
      - `name` (required): string
      - `timing` (required): object
      - `days` (required): object
      - `timezone` (required): string enum=['Etc/GMT+12', 'Etc/GMT+11', 'Etc/GMT+10', 'America/Anchorage', 'America/Dawson', 'America/Creston', 'America/Chihuahua', 'America/Boise', 'America/Belize', 'America/Chicago', 'America/Bahia_Banderas', 'America/Regina']
- `sequences`: array — List of sequences (the actual email copy). Even though this field is an array, only the first element is used, so please provide only one ar...
  (array of)
    - `steps` (required): array — The steps of the sequence. Each sequence needs at least one step.
- `timestamp_created` (required): string — Timestamp when the campaign was created
- `timestamp_updated` (required): string — Timestamp when the campaign was last updated
- `email_gap`: null|number — The gap between emails in minutes
- `random_wait_max`: null|number — The maximum random wait time in minutes
- `text_only`: null|boolean — Whether the campaign is text only
- `first_email_text_only`: null|boolean — Whether the campaign is send the first email as a text only
- `email_list`: array — List of accounts to use for sending emails
  (array of)
- `daily_limit`: null|number — The daily limit for sending emails
- `stop_on_reply`: null|boolean — Whether to stop the campaign on reply
- `email_tag_list`: array — List of tags to use for sending emails
  (array of)
- `link_tracking`: null|boolean — Whether to track links in emails
- `open_tracking`: boolean — Whether to track opens in emails
- `stop_on_auto_reply`: null|boolean — Whether to stop the campaign on auto reply
- `daily_max_leads`: null|integer — The daily maximum new leads to contact
- `prioritize_new_leads`: null|boolean — Whether to prioritize new leads
- `auto_variant_select`: null|object — Auto variant select settings
  - `trigger` (required): string enum=['reply_rate', 'click_rate', 'open_rate']
- `match_lead_esp`: null|boolean — Whether to match leads by ESP
- `not_sending_status`: null|number enum=[1, 2, 3, 4, 99] — Campaign not sending status
- `stop_for_company`: null|boolean — Whether to stop the campaign for the entire company(domain) when a lead replies
- `core_variables`: null|object — Campaign core variables
- `custom_variables`: null|object — Campaign custom variables
- `insert_unsubscribe_header`: null|boolean — Whether to insert an unsubscribe header in emails
- `allow_risky_contacts`: null|boolean — Whether to allow risky contacts
- `disable_bounce_protect`: null|boolean — Whether to disable bounce protection
- `limit_emails_per_company_override`: null|object — Overrides the workspace-wide limit emails per company setting for this campaign.
  - `mode` (required): string enum=['custom', 'disabled']
  - `daily_limit`: number
  - `scope`: string enum=['per_campaign', 'across_workspace']
- `cc_list`: array — List of accounts to CC on emails
  (array of)
- `bcc_list`: array — List of accounts to BCC on emails
  (array of)
- `organization`: null|string — Organization ID
- `owned_by`: null|string — Owner ID
- `created_by`: null|string — ID of the user who created the campaign
- `ai_sdr_id`: null|string — AI Sales Agent ID that created this campaign
- `provider_routing_rules`: array — Auto variant select settings
  (array of)
    - `action`: string enum=['send', 'do_not_send']
    - `recipient_esp`: array
    - `sender_esp`: array

## POST /api/v2/campaigns/{id}/activate
_Activate(start), or resume a campaign_  
Requires one of the following scopes: `campaigns:update`, `campaigns:all`, `all:update`, `all:all`

**Params**
- `id` (path): string — Campaign ID

**200 response**
- `id` (required): string — Unique identifier for the campaign
- `name` (required): string — Name of the campaign
- `pl_value`: null|number — Value of every positive lead
- `status` (required): number enum=[-99, -1, -2, 0, 1, 2, 3, 4] — Campaign Status
- `is_evergreen`: null|boolean — Whether the campaign is evergreen
- `campaign_schedule` (required): object — Campaign schedule
  - `start_date`: null|string — Start date in YYYY-MM-DD format. Uses the campaign's timezone.
  - `end_date`: null|string — End date in YYYY-MM-DD format. Uses the campaign's timezone.
  - `schedules` (required): array
    (array of)
      - `name` (required): string
      - `timing` (required): object
      - `days` (required): object
      - `timezone` (required): string enum=['Etc/GMT+12', 'Etc/GMT+11', 'Etc/GMT+10', 'America/Anchorage', 'America/Dawson', 'America/Creston', 'America/Chihuahua', 'America/Boise', 'America/Belize', 'America/Chicago', 'America/Bahia_Banderas', 'America/Regina']
- `sequences`: array — List of sequences (the actual email copy). Even though this field is an array, only the first element is used, so please provide only one ar...
  (array of)
    - `steps` (required): array — The steps of the sequence. Each sequence needs at least one step.
- `timestamp_created` (required): string — Timestamp when the campaign was created
- `timestamp_updated` (required): string — Timestamp when the campaign was last updated
- `email_gap`: null|number — The gap between emails in minutes
- `random_wait_max`: null|number — The maximum random wait time in minutes
- `text_only`: null|boolean — Whether the campaign is text only
- `first_email_text_only`: null|boolean — Whether the campaign is send the first email as a text only
- `email_list`: array — List of accounts to use for sending emails
  (array of)
- `daily_limit`: null|number — The daily limit for sending emails
- `stop_on_reply`: null|boolean — Whether to stop the campaign on reply
- `email_tag_list`: array — List of tags to use for sending emails
  (array of)
- `link_tracking`: null|boolean — Whether to track links in emails
- `open_tracking`: boolean — Whether to track opens in emails
- `stop_on_auto_reply`: null|boolean — Whether to stop the campaign on auto reply
- `daily_max_leads`: null|integer — The daily maximum new leads to contact
- `prioritize_new_leads`: null|boolean — Whether to prioritize new leads
- `auto_variant_select`: null|object — Auto variant select settings
  - `trigger` (required): string enum=['reply_rate', 'click_rate', 'open_rate']
- `match_lead_esp`: null|boolean — Whether to match leads by ESP
- `not_sending_status`: null|number enum=[1, 2, 3, 4, 99] — Campaign not sending status
- `stop_for_company`: null|boolean — Whether to stop the campaign for the entire company(domain) when a lead replies
- `core_variables`: null|object — Campaign core variables
- `custom_variables`: null|object — Campaign custom variables
- `insert_unsubscribe_header`: null|boolean — Whether to insert an unsubscribe header in emails
- `allow_risky_contacts`: null|boolean — Whether to allow risky contacts
- `disable_bounce_protect`: null|boolean — Whether to disable bounce protection
- `limit_emails_per_company_override`: null|object — Overrides the workspace-wide limit emails per company setting for this campaign.
  - `mode` (required): string enum=['custom', 'disabled']
  - `daily_limit`: number
  - `scope`: string enum=['per_campaign', 'across_workspace']
- `cc_list`: array — List of accounts to CC on emails
  (array of)
- `bcc_list`: array — List of accounts to BCC on emails
  (array of)
- `organization`: null|string — Organization ID
- `owned_by`: null|string — Owner ID
- `created_by`: null|string — ID of the user who created the campaign
- `ai_sdr_id`: null|string — AI Sales Agent ID that created this campaign
- `provider_routing_rules`: array — Auto variant select settings
  (array of)
    - `action`: string enum=['send', 'do_not_send']
    - `recipient_esp`: array
    - `sender_esp`: array

## POST /api/v2/campaigns/{id}/pause
_Stop(or pause) a campaign_  
Requires one of the following scopes: `campaigns:update`, `campaigns:all`, `all:update`, `all:all`

**Params**
- `id` (path): string — Campaign ID

**200 response**
- `id` (required): string — Unique identifier for the campaign
- `name` (required): string — Name of the campaign
- `pl_value`: null|number — Value of every positive lead
- `status` (required): number enum=[-99, -1, -2, 0, 1, 2, 3, 4] — Campaign Status
- `is_evergreen`: null|boolean — Whether the campaign is evergreen
- `campaign_schedule` (required): object — Campaign schedule
  - `start_date`: null|string — Start date in YYYY-MM-DD format. Uses the campaign's timezone.
  - `end_date`: null|string — End date in YYYY-MM-DD format. Uses the campaign's timezone.
  - `schedules` (required): array
    (array of)
      - `name` (required): string
      - `timing` (required): object
      - `days` (required): object
      - `timezone` (required): string enum=['Etc/GMT+12', 'Etc/GMT+11', 'Etc/GMT+10', 'America/Anchorage', 'America/Dawson', 'America/Creston', 'America/Chihuahua', 'America/Boise', 'America/Belize', 'America/Chicago', 'America/Bahia_Banderas', 'America/Regina']
- `sequences`: array — List of sequences (the actual email copy). Even though this field is an array, only the first element is used, so please provide only one ar...
  (array of)
    - `steps` (required): array — The steps of the sequence. Each sequence needs at least one step.
- `timestamp_created` (required): string — Timestamp when the campaign was created
- `timestamp_updated` (required): string — Timestamp when the campaign was last updated
- `email_gap`: null|number — The gap between emails in minutes
- `random_wait_max`: null|number — The maximum random wait time in minutes
- `text_only`: null|boolean — Whether the campaign is text only
- `first_email_text_only`: null|boolean — Whether the campaign is send the first email as a text only
- `email_list`: array — List of accounts to use for sending emails
  (array of)
- `daily_limit`: null|number — The daily limit for sending emails
- `stop_on_reply`: null|boolean — Whether to stop the campaign on reply
- `email_tag_list`: array — List of tags to use for sending emails
  (array of)
- `link_tracking`: null|boolean — Whether to track links in emails
- `open_tracking`: boolean — Whether to track opens in emails
- `stop_on_auto_reply`: null|boolean — Whether to stop the campaign on auto reply
- `daily_max_leads`: null|integer — The daily maximum new leads to contact
- `prioritize_new_leads`: null|boolean — Whether to prioritize new leads
- `auto_variant_select`: null|object — Auto variant select settings
  - `trigger` (required): string enum=['reply_rate', 'click_rate', 'open_rate']
- `match_lead_esp`: null|boolean — Whether to match leads by ESP
- `not_sending_status`: null|number enum=[1, 2, 3, 4, 99] — Campaign not sending status
- `stop_for_company`: null|boolean — Whether to stop the campaign for the entire company(domain) when a lead replies
- `core_variables`: null|object — Campaign core variables
- `custom_variables`: null|object — Campaign custom variables
- `insert_unsubscribe_header`: null|boolean — Whether to insert an unsubscribe header in emails
- `allow_risky_contacts`: null|boolean — Whether to allow risky contacts
- `disable_bounce_protect`: null|boolean — Whether to disable bounce protection
- `limit_emails_per_company_override`: null|object — Overrides the workspace-wide limit emails per company setting for this campaign.
  - `mode` (required): string enum=['custom', 'disabled']
  - `daily_limit`: number
  - `scope`: string enum=['per_campaign', 'across_workspace']
- `cc_list`: array — List of accounts to CC on emails
  (array of)
- `bcc_list`: array — List of accounts to BCC on emails
  (array of)
- `organization`: null|string — Organization ID
- `owned_by`: null|string — Owner ID
- `created_by`: null|string — ID of the user who created the campaign
- `ai_sdr_id`: null|string — AI Sales Agent ID that created this campaign
- `provider_routing_rules`: array — Auto variant select settings
  (array of)
    - `action`: string enum=['send', 'do_not_send']
    - `recipient_esp`: array
    - `sender_esp`: array

## GET /api/v2/campaigns/analytics
_Get campaign(s) analytics_  
Get analytics for one or multiple campaigns. Specify the `id` field to get the analytics for a single campaign, or leave it empty to get the analytics for all campaigns

**Params**
- `id` (query): string — A campaign ID to get the analytics for. Leave this field empty to get the analytics for all campaigns
- `ids` (query): array
- `start_date` (query): string — Start of the analytics range. Accepts a date-only value (`YYYY-MM-DD`) or a full ISO 8601 timestamp. Date-only values are interpreted as UTC
- `end_date` (query): string — End of the analytics range. Accepts a date-only value (`YYYY-MM-DD`) or a full ISO 8601 timestamp. Date-only values are interpreted as UTC m
- `exclude_total_leads_count` (query): boolean — Exclude the total leads from the result. Setting this to true will considerably decrease the response time

**200 response**
(array of)
  - `campaign_name` (required): string — The name of the campaign
  - `campaign_id` (required): string — The ID of the campaign
  - `campaign_status` (required): number — The campaign status
  - `campaign_is_evergreen` (required): boolean — Whether the campaign is evergreen
  - `leads_count` (required): integer — The total number of leads
  - `contacted_count` (required): integer — Number of leads for whom the sequence has started
  - `emails_sent_count` (required): integer — The total number of sent emails
  - `new_leads_contacted_count` (required): integer — The total number of new leads contacted
  - `open_count` (required): integer — The number of leads that opened at least one email
  - `open_count_unique`: integer — The number of unique email opens (first open per lead)
  - `open_count_unique_by_step`: integer — The number of unique email opens per step (first open per lead per step)
  - `reply_count` (required): integer — The total number of replies received (if a lead replies multiple times, each reply is counted)
  - `reply_count_unique`: integer — The number of unique replies (first reply per lead). Excludes automatic replies.
  - `reply_count_unique_by_step`: integer — The number of unique replies per step (first reply per lead per step). Excludes automatic replies.
  - `reply_count_automatic`: integer — The total number of automatic replies detected
  - `reply_count_automatic_unique`: integer — The number of unique automatic replies (first automatic reply per lead)
  - `reply_count_automatic_unique_by_step`: integer — The number of unique automatic replies per step
  - `link_click_count` (required): integer — The number of links that got clicked
  - `link_click_count_unique`: integer — The number of unique link clicks (first click per lead)
  - `link_click_count_unique_by_step`: integer — The number of unique link clicks per step (first click per lead per step)
  - `bounced_count` (required): integer — The number of bounced leads
  - `unsubscribed_count` (required): integer — The number of unsubscribed leads
  - `completed_count` (required): integer — The number of leads that the campaign was completed for
  - `total_opportunities` (required): integer — The total number of unique opportunities created
  - `total_opportunity_value` (required): number — The total value of opportunities created

## POST /api/v2/leads
_Create lead_  
Requires one of the following scopes: `leads:create`, `leads:all`, `all:create`, `all:all`

**Body**
- `campaign`: string|null — Campaign ID associated with the lead
- `email`: string|null — Email address of the lead
- `personalization`: string|null — Personalization of the lead
- `website`: string|null — Website of the lead
- `last_name`: string|null — Last name of the lead
- `first_name`: string|null — First name of the lead
- `company_name`: string|null — Company name of the lead
- `job_title`: string|null — Job title of the lead
- `phone`: string|null — Phone number of the lead
- `lt_interest_status`: number enum=[1, 2, 3, 4, 0, -1, -2, -3, -4] — Lead interest status. It can be either a static value (check below), or a custom status interest value
- `pl_value_lead`: string|null — Potential value of the lead
- `list_id`: string|null — List ID associated with the lead
- `assigned_to`: string|null — ID of the user assigned to the lead
- `skip_if_in_workspace`: boolean — Whether to skip if the lead is already in the workspace.
- `skip_if_in_campaign`: boolean — Whether to skip if the lead is already in the campaign.
- `skip_if_in_list`: boolean — Whether to skip if the lead is already in the list.
- `blocklist_id`: string — The ID of the blocklist to check for the lead.
- `verify_leads_for_lead_finder`: boolean — Whether to verify the leads for the lead finder.
- `verify_leads_on_import`: boolean — Whether to verify the leads on import.
- `custom_variables`: object — Custom variables can include any metadata about the lead that is relevant to the campaign, the campaign will be updated to allow all the oth...

**200 response**
- `id` (required): string — Unique identifier for the lead
- `timestamp_created` (required): string — Timestamp when the lead was created
- `timestamp_updated` (required): string — Timestamp when the lead was last updated
- `organization` (required): string — Organization ID associated with the lead
- `campaign`: null|string — Campaign ID associated with the lead
- `status` (required): number enum=[1, 2, 3, -1, -2, -3] — Status of the lead
- `email`: null|string — Email address of the lead
- `personalization`: null|string — Personalization of the lead
- `website`: null|string — Website of the lead
- `last_name`: null|string — Last name of the lead
- `first_name`: null|string — First name of the lead
- `company_name`: null|string — Company name of the lead
- `job_title`: null|string — Job title of the lead
- `phone`: null|string — Phone number of the lead
- `email_open_count` (required): number — Number of times the email was opened
- `email_reply_count` (required): number — Number of times the email was replied to
- `email_click_count` (required): number — Number of times the email was clicked
- `company_domain` (required): string — Company domain of the lead
- `status_summary` (required): object — Status summary of the lead
  - `lastStep`: object
    - `from`: string
    - `stepID`: string
    - `timestamp_executed`: string
  - `domain_complete`: boolean
- `payload`: null|object — Lead custom variables. This object can contain any key, but the values have to be of type string, number, boolean, or null. We do NOT allow ...
  - `firstName`: string
  - `lastName`: string
  - `companyName`: string
  - `jobTitle`: string
  - `website`: string
  - `phone`: string
  - `personalization`: string
- `status_summary_subseq`: object — Subsequence status summary of the lead
  - `from`: string
  - `stepID`: string
  - `timestampExecuted`: string
- `last_step_from`: null|string — Source of the last step
- `last_step_id`: null|string — ID of the last step
- `last_step_timestamp_executed`: null|string — Timestamp when the last step was executed
- `email_opened_step`: null|number — Last email step opened by the lead
- `email_opened_variant`: null|number — Last step variant opened by the lead
- `email_replied_step`: null|number — Last email step the lead has replied to
- `email_replied_variant`: null|number — Last step variant the lead has replied to
- `email_clicked_step`: null|number — Last email step the lead has clicked
- `email_clicked_variant`: null|number — Last step variant the lead has clicked
- `lt_interest_status`: number enum=[1, 2, 3, 4, 0, -1, -2, -3, -4] — Lead interest status. It can be either a static value (check below), or a custom status interest value
- `subsequence_id`: null|string — ID of the subsequence
- `verification_status`: number enum=[0, 1, -1, -2, -3, -4, 11, 12] — Verification status of the lead
- `pl_value_lead`: null|string — Potential value of the lead
- `timestamp_added_subsequence`: null|string — Timestamp when the lead was added to the subsequence
- `timestamp_last_contact`: null|string — Timestamp of the last contact with the lead
- `timestamp_last_open`: null|string — Timestamp of the last email open
- `timestamp_last_reply`: null|string — Timestamp of the last email reply
- `timestamp_last_interest_change`: null|string — Timestamp of the last interest status change
- `timestamp_last_click`: null|string — Timestamp of the last email click
- `enrichment_status`: number enum=[1, -1, 11, -2] — Enrichment status of the lead
- `list_id`: null|string — List ID associated with the lead
- `last_contacted_from`: null|string — Source of the last contact
- `uploaded_by_user`: null|string — ID of the user who uploaded the lead
- `upload_method`: string enum=['manual', 'api', 'website-visitor'] — Method used to upload the lead
- `assigned_to`: null|string — ID of the user assigned to the lead
- `is_website_visitor`: null|boolean — Indicates if the lead is a website visitor
- `timestamp_last_touch`: null|string — Timestamp of the last touch with the lead
- `esp_code`: number enum=[0, 1, 2, 3, 8, 9, 10, 12, 13, 999, 1000] — ESP code associated with the lead
- `esg_code`: number enum=[0, 1, 2, 3, 4] — ESG code associated with the lead

## POST /api/v2/leads/add
_Add leads in bulk to a campaign or list_  
Adds up to 1000 leads to either a campaign or a list. You must provide a `campaign_id` or a `list_id`, but not both. The endpoint validates emails, checks against blocklists and existing leads.   Requires one of the following scopes: `leads:create`, `leads:all`, `all:create`, `all:all`

**Body**
- `campaign_id`: string — The unique identifier for the campaign to add leads to. Use this field OR `list_id`, but not both.
- `list_id`: string — The unique identifier for the list to add leads to. Use this field OR `campaign_id`, but not both.
- `leads` (required): array — An array of lead objects to create. When using `campaign_id`: Each lead object must contain an `email`. When using `list_id` Each lead objec...
  (array of)
    - `email`: string|null — Email address of the lead
    - `personalization`: string|null — Personalization of the lead
    - `website`: string|null — Website of the lead
    - `last_name`: string|null — Last name of the lead
    - `first_name`: string|null — First name of the lead
    - `company_name`: string|null — Company name of the lead
    - `job_title`: string|null — Job title of the lead
    - `phone`: string|null — Phone number of the lead
    - `lt_interest_status`: number enum=[1, 2, 3, 4, 0, -1, -2, -3, -4] — Lead interest status. It can be either a static value (check below), or a custom status interest value
    - `pl_value_lead`: string|null — Potential value of the lead
    - `assigned_to`: string|null — ID of the user assigned to the lead
    - `custom_variables`: object — Custom variables can include any metadata about the lead that is relevant to the campaign, the campaign will be updated to allow all the oth...
- `blocklist_id`: string|null — Optional blocklist ID to check leads against. If omitted, the workspace default blocklist is used.
- `assigned_to`: string — Optional user ID to assign all imported leads to. If omitted, leads are assigned to the campaign owner when `campaign_id` is defined, or the...
- `verify_leads_on_import`: boolean — If true, a background job will be created to verify the email addresses of the imported leads.
- `skip_if_in_workspace`: boolean — If true, any lead that already exists anywhere in your workspace (in any campaign or list) will be skipped. This option overrides the other ...
- `skip_if_in_campaign`: boolean — If true, any lead that already exists in ANY campaign in your workspace will be skipped.
- `skip_if_in_list`: boolean — If true, any lead that already exists in ANY list in your workspace will be skipped.

**200 response**
- `status` (required): string — Indicates the request was processed.
- `total_sent` (required): integer — The total number of leads included in the request payload.
- `leads_uploaded` (required): integer — The number of leads that were successfully created.
- `in_blocklist` (required): integer — The number of leads that were skipped because their email was found on the blocklist.
- `blocklist_used` (required): null|string — The ID of the blocklist that was used for the check.
- `duplicated_leads` (required): integer — The number of leads that were already in this specific campaign or list and were not re-added.
- `skipped_count` (required): integer — The number of leads skipped due to the `skip_if_in_...` flags being enabled.
- `invalid_email_count` (required): integer — The number of leads skipped due to an invalid email format or a missing email address.
- `incomplete_count` (required): integer — The number of leads skipped due to missing email and names. Only calculated for lists.
- `duplicate_email_count` (required): integer — The number of leads skipped because their email was duplicated within the request payload itself.
- `remaining_in_plan` (required): null|integer — The remaining lead uploads in the current billing plan. This value is only present in the response when a `campaign_id` is provided.
- `created_leads` (required): array — A list of created leads with their summary information. You can use this to map your input to the created leads.
  (array of)
    - `index` (required): integer — The index of the lead in the input array. For leads that have no email address you can use this field as the key to your input leads.
    - `id` (required): string — The ID of the lead. Use it for GET, DELETE or PATCH operations.
    - `email`: null|string
    - `first_name`: null|string
    - `last_name`: null|string
    - `phone`: null|string

## POST /api/v2/leads/list
_List leads_  
This endpoint is a POST endpoint, instead of GET - a deviation from the REST APIs standards we’re following because of the complex arguments it accepts, which would be too hard to express through query parameters. Results are ordered by each lead's `id` field in ascending order (or by `contact` when distinct_contacts is true) so clients can paginate chronologically by reusing the cursor returned i

**Body**
- `search`: string — Search term matched against the lead's email and profile fields (first and last name, company, job title, and similar). Matches whole words,...
- `filter`: string — Filter criteria for leads. For custom lead labels, use the `interest_status` field.
- `campaign`: string — Campaign ID to filter leads
- `list_id`: string — List ID to filter leads
- `in_campaign`: boolean — Whether the lead is in a campaign
- `in_list`: boolean — Whether the lead is in a list
- `ids`: array — Array of lead IDs to include
  (array of)
- `queries`: array
  (array of)
    - `actionType` (required): string enum=['reply', 'email-open', 'last-contacted', 'link-click', 'lead-status', 'lead-status-change']
    - `values` (required): object
      - `occurrence-days`: number — Only leads whose last matching activity was in the past this many days.
      - `occurrence-count`: object — Compares how many times the activity happened. Without `count`, it compares with 0, so `{ "condition": "more" }` means at least once. Ignore...
      - `lead-status`: object — Only for `lead-status`: compares the lead status. `status` is required with `condition`.
- `excluded_ids`: array — Array of lead IDs to exclude
  (array of)
- `contacts`: array — Array of emails the leads needs to have
  (array of)
- `limit`: integer — The number of items to return
- `starting_after`: string — Forward pagination cursor. When distinct_contacts is false, provide the `id` value from the last lead of the previous page; when true, provi...
- `organization_user_ids`: array — Array of organization user IDs to filter leads
  (array of)
- `smart_view_id`: string — Smart view ID to filter leads
- `is_website_visitor`: boolean — Whether the lead is a website visitor
- `distinct_contacts`: boolean — Whether to return distinct contacts
- `enrichment_status`: number enum=[1, -1, 11, -2] — Enrichment status to filter leads
- `esg_code`: string enum=['0', '1', '2', '3', '4', 'all', 'none'] — ESG code to filter leads

**200 response**
- `items` (required): array — The list of Lead
  (array of)
    - `id` (required): string — Unique identifier for the lead
    - `timestamp_created` (required): string — Timestamp when the lead was created
    - `timestamp_updated` (required): string — Timestamp when the lead was last updated
    - `organization` (required): string — Organization ID associated with the lead
    - `campaign`: null|string — Campaign ID associated with the lead
    - `status` (required): number enum=[1, 2, 3, -1, -2, -3] — Status of the lead
    - `email`: null|string — Email address of the lead
    - `personalization`: null|string — Personalization of the lead
    - `website`: null|string — Website of the lead
    - `last_name`: null|string — Last name of the lead
    - `first_name`: null|string — First name of the lead
    - `company_name`: null|string — Company name of the lead
    - `job_title`: null|string — Job title of the lead
    - `phone`: null|string — Phone number of the lead
    - `email_open_count` (required): number — Number of times the email was opened
    - `email_reply_count` (required): number — Number of times the email was replied to
    - `email_click_count` (required): number — Number of times the email was clicked
    - `company_domain` (required): string — Company domain of the lead
    - `status_summary` (required): object — Status summary of the lead
    - `payload`: null|object — Lead custom variables. This object can contain any key, but the values have to be of type string, number, boolean, or null. We do NOT allow ...
    - `status_summary_subseq`: object — Subsequence status summary of the lead
    - `last_step_from`: null|string — Source of the last step
    - `last_step_id`: null|string — ID of the last step
    - `last_step_timestamp_executed`: null|string — Timestamp when the last step was executed
    - `email_opened_step`: null|number — Last email step opened by the lead
    - `email_opened_variant`: null|number — Last step variant opened by the lead
    - `email_replied_step`: null|number — Last email step the lead has replied to
    - `email_replied_variant`: null|number — Last step variant the lead has replied to
    - `email_clicked_step`: null|number — Last email step the lead has clicked
    - `email_clicked_variant`: null|number — Last step variant the lead has clicked
    - `lt_interest_status`: number enum=[1, 2, 3, 4, 0, -1, -2, -3, -4] — Lead interest status. It can be either a static value (check below), or a custom status interest value
    - `subsequence_id`: null|string — ID of the subsequence
    - `verification_status`: number enum=[0, 1, -1, -2, -3, -4, 11, 12] — Verification status of the lead
    - `pl_value_lead`: null|string — Potential value of the lead
    - `timestamp_added_subsequence`: null|string — Timestamp when the lead was added to the subsequence
    - `timestamp_last_contact`: null|string — Timestamp of the last contact with the lead
    - `timestamp_last_open`: null|string — Timestamp of the last email open
    - `timestamp_last_reply`: null|string — Timestamp of the last email reply
    - `timestamp_last_interest_change`: null|string — Timestamp of the last interest status change
    - `timestamp_last_click`: null|string — Timestamp of the last email click
    - `enrichment_status`: number enum=[1, -1, 11, -2] — Enrichment status of the lead
    - `list_id`: null|string — List ID associated with the lead
    - `last_contacted_from`: null|string — Source of the last contact
    - `uploaded_by_user`: null|string — ID of the user who uploaded the lead
    - `upload_method`: string enum=['manual', 'api', 'website-visitor'] — Method used to upload the lead
    - `assigned_to`: null|string — ID of the user assigned to the lead
    - `is_website_visitor`: null|boolean — Indicates if the lead is a website visitor
    - `timestamp_last_touch`: null|string — Timestamp of the last touch with the lead
    - `esp_code`: number enum=[0, 1, 2, 3, 8, 9, 10, 12, 13, 999, 1000] — ESP code associated with the lead
    - `esg_code`: number enum=[0, 1, 2, 3, 4] — ESG code associated with the lead
- `next_starting_after`: string — The filter for getting the next items after this one, this could either be a UUID, a timestamp, on an email depending on the specific API

## POST /api/v2/leads/update-interest-status
_Update the interest status of a lead_  
Update the interest status of a lead

**Body**
- `lead_email` (required): string — The email of the lead to update the interest status of.
- `interest_value` (required): number|null — Set this field to "null" to reset the lead value to "Lead". This is the same as moving the lead to the "Lead" status in the web app. Please ...
- `campaign_id`: string — The ID of the campaign to update the interest status of.
- `ai_interest_value`: number — The AI interest value to set for the lead.
- `disable_auto_interest`: boolean — Suppresses AI-authored interest handling when `ai_interest_value` is supplied. Without an AI value, an explicit `interest_value` update reta...
- `list_id`: string — The ID of the list to update the interest status of.

## GET /api/v2/emails
_List email_  
**Rate Limit:** This endpoint has a rate limit of 20 requests per minute, unlike other API endpoints.   Requires one of the following scopes: `emails:read`, `emails:all`, `all:read`, `all:all`

**Params**
- `limit` (query): integer — The number of items to return
- `starting_after` (query): string — The ID of the last item in the previous page - used for pagination. You can use the value of the `next_starting_after` field from the previo
- `search` (query): string — The search query to filter emails. It can be an email address (the lead email address), or a special string that starts with "thread:" to se
- `campaign_id` (query): string — The ID of the campaign to filter emails by.
- `list_id` (query): string — The ID of the lead list to filter emails by.
- `i_status` (query): number — The status of the emails to filter by.
- `eaccount` (query): string — The email account that was used to send this email. You can filter by multiple email accounts by providing a comma-separated list of email a
- `is_unread` (query): boolean — Whether the email is unread.
- `has_reminder` (query): boolean
- `mode` (query): string enum=['emode_focused', 'emode_others', 'emode_all'] — The mode to filter emails by.
- `preview_only` (query): boolean — Whether to only return the preview of the emails.
- `sort_order` (query): string enum=['asc', 'desc'] — The order to sort the emails by (based on the email creation date). Default is "desc".
- `scheduled_only` (query): boolean — Whether to only return the scheduled emails.
- `assigned_to` (query): string — The ID of the user to filter emails by.
- `lead` (query): string — The email of the lead to filter emails by.
- `company_domain` (query): string — The domain of the company to filter emails by.
- `marked_as_done` (query): boolean — Whether the email is marked as done.
- `email_type` (query): string enum=['received', 'sent', 'manual'] — The type of the email to filter by.
- `min_timestamp_created` (query): string — Filter emails created after this timestamp (ISO format)
- `max_timestamp_created` (query): string — Filter emails created before this timestamp (ISO format)
- `latest_of_thread` (query): boolean — Whether to only return the latest email in each thread.

**200 response**
- `items` (required): array — The list of Email
  (array of)
    - `id` (required): string — A Unique identifier
    - `timestamp_created` (required): string — Timestamp when the email was added to our database. This is not the timestamp of the email itself, since the email could have been sent at a...
    - `timestamp_email` (required): string — The timestamp of the email, as provided by the email server. Please note that the timestamp is not always accurate, as it can be manipulated...
    - `message_id` (required): string — Unique email ID from the email server
    - `subject` (required): string — Subject line of the email message
    - `from_address_email`: null|string — The sender email address, populated based on the eaccount
    - `to_address_email_list` (required): string — Comma-separated list of recipient email addresses
    - `cc_address_email_list`: null|string — Comma-separated list of CC email addresses
    - `bcc_address_email_list`: null|string — Comma-separated list of BCC email addresses
    - `reply_to`: null|string — Reply-to email address
    - `body` (required): object — An object containing the email body in HTML and text format
    - `organization_id` (required): string — The workspace ID
    - `campaign_id`: null|string — The id of the campaign that the email is associated with (it can be null for manually sent emails)
    - `subsequence_id`: null|string — The id of the campaign subsequence that the email is associated with (it can be null for manually sent emails)
    - `list_id`: null|string — The id of the list (if the lead is part of a list)
    - `lead`: null|string — The email address of the lead that the email is associated with
    - `lead_id`: null|string — The lead id (if any)
    - `eaccount` (required): string — The email account that was used to send the email. This needs to be validated to make sure it exists in the user workspace
    - `ue_type`: null|number enum=[1, 2, 3, 4] — Email type based on the life cycle of the email
    - `step`: null|string — The campaign step that the email is associated with
    - `is_unread`: null|number — Indicates if the email is unread
    - `is_auto_reply`: null|number — Indicates if the email is an auto-reply. 0 (zero) - is false, and 1 is true
    - `reminder_ts`: null|string — Timestamp for the reminder.
    - `ai_interest_value`: null|number — AI interest value
    - `ai_assisted`: null|number — Indicates if AI assistance was used
    - `is_focused`: null|number — Indicates if the email is focused (is in the primary tab in the Unibox)
    - `i_status`: null|number — Indicates the interest status of the email
    - `thread_id`: null|string — Identifier for the email thread. All the emails in the same thread have the same thread ID
    - `content_preview`: null|string — A short preview of the email content (usually the first few lines of the email)
    - `attachment_json`: null|object — Attachment metadata for the email. This field is null when there are no attachments.
    - `from_address_json`: null|array — List of from address details
    - `to_address_json`: null|array — List of to address details
    - `cc_address_json`: null|array — List of CC address details
    - `ai_agent_id`: null|string — ID of the AI agent that sent this email (if applicable)
- `next_starting_after`: string — The filter for getting the next items after this one, this could either be a UUID, a timestamp, on an email depending on the specific API

## POST /api/v2/emails/reply
_Reply to an email_  
Send a reply to an email. This endpoint can be used to send an email only as a reply to an existing email. In order to reply to an email, please specify the `reyply_to_uuid` field, and your email will be sent as a reply to that email. The `reyply_to_uuid` field represents the `id` field of an existing email, which is being returned to you in all the `/email` endpoints   Requires one of the followi

**Body**
- `eaccount` (required): string — The email account that will be used to send this email. It has to be an email account connected to your workspace
- `reply_to_uuid` (required): string — The id of the email to reply to
- `subject` (required): string — Subject line of the email message
- `body` (required): object — The email body. You can specify either the `html` or the `text` field, or both. Use `<br/>` tags for delivered email line breaks.
  - `html`: string — HTML body of the email message. Use `<br/>` tags for delivered email line breaks.
  - `text`: string — Text body of the email message. For delivered email line breaks, use `html` with `<br/>` tags.
- `additional_recipients`: array — Optional list of extra recipient email addresses to include in the reply, in addition to the default recipient (the sender of the email bein...
  (array of)
- `cc_address_email_list`: string — Comma-separated list of CC email addresses
- `bcc_address_email_list`: string — Comma-separated list of BCC email addresses
- `reminder_ts`: string — If provided then a reminder will be attached to this email, you will see this reminder in the Unibox in the web app
- `assigned_to`: string — The user id assigned to the lead

**200 response**
- `id` (required): string — A Unique identifier
- `timestamp_created` (required): string — Timestamp when the email was added to our database. This is not the timestamp of the email itself, since the email could have been sent at a...
- `timestamp_email` (required): string — The timestamp of the email, as provided by the email server. Please note that the timestamp is not always accurate, as it can be manipulated...
- `message_id` (required): string — Unique email ID from the email server
- `subject` (required): string — Subject line of the email message
- `from_address_email`: null|string — The sender email address, populated based on the eaccount
- `to_address_email_list` (required): string — Comma-separated list of recipient email addresses
- `cc_address_email_list`: null|string — Comma-separated list of CC email addresses
- `bcc_address_email_list`: null|string — Comma-separated list of BCC email addresses
- `reply_to`: null|string — Reply-to email address
- `body` (required): object — An object containing the email body in HTML and text format
  - `text`: string — Plain-text representation of the email body. Newline characters are preserved as line breaks in this text view.
  - `html`: string — HTML content of the email. Use `<br/>` tags for delivered email line breaks.
- `organization_id` (required): string — The workspace ID
- `campaign_id`: null|string — The id of the campaign that the email is associated with (it can be null for manually sent emails)
- `subsequence_id`: null|string — The id of the campaign subsequence that the email is associated with (it can be null for manually sent emails)
- `list_id`: null|string — The id of the list (if the lead is part of a list)
- `lead`: null|string — The email address of the lead that the email is associated with
- `lead_id`: null|string — The lead id (if any)
- `eaccount` (required): string — The email account that was used to send the email. This needs to be validated to make sure it exists in the user workspace
- `ue_type`: null|number enum=[1, 2, 3, 4] — Email type based on the life cycle of the email
- `step`: null|string — The campaign step that the email is associated with
- `is_unread`: null|number — Indicates if the email is unread
- `is_auto_reply`: null|number — Indicates if the email is an auto-reply. 0 (zero) - is false, and 1 is true
- `reminder_ts`: null|string — Timestamp for the reminder.
- `ai_interest_value`: null|number — AI interest value
- `ai_assisted`: null|number — Indicates if AI assistance was used
- `is_focused`: null|number — Indicates if the email is focused (is in the primary tab in the Unibox)
- `i_status`: null|number — Indicates the interest status of the email
- `thread_id`: null|string — Identifier for the email thread. All the emails in the same thread have the same thread ID
- `content_preview`: null|string — A short preview of the email content (usually the first few lines of the email)
- `attachment_json`: null|object — Attachment metadata for the email. This field is null when there are no attachments.
  - `files` (required): array
    (array of)
      - `filename` (required): string — Attachment file name
      - `size`: number — Attachment file size in bytes
      - `type`: string — Attachment MIME type
      - `url`: string — Download URL when available
      - `error`: null|string — Error description when the attachment failed to upload
- `from_address_json`: null|array — List of from address details
- `to_address_json`: null|array — List of to address details
- `cc_address_json`: null|array — List of CC address details
- `ai_agent_id`: null|string — ID of the AI agent that sent this email (if applicable)

## GET /api/v2/emails/unread/count
_Count unread emails_  
Requires one of the following scopes: `emails:read`, `emails:all`, `all:read`, `all:all`

**200 response**
- `count`: number

## POST /api/v2/emails/threads/{thread_id}/mark-as-read
_Mark all emails in a thread as read_  
Requires one of the following scopes: `emails:update`, `emails:all`, `all:update`, `all:all`

**Params**
- `thread_id` (path): string

**200 response**
- `success`: boolean

## POST /api/v2/block-lists-entries
_Create block list entry_  
Requires one of the following scopes: `block_list_entries:create`, `block_list_entries:all`, `all:create`, `all:all`

**Body**
- `bl_value` (required): string — The email or domain to block

**200 response**
- `id` (required): string — Unique identifier for the block list entry
- `timestamp_created` (required): string — Timestamp when the block list entry was created
- `organization_id` (required): string — Organization ID that owns this block list entry
- `bl_value` (required): string — The email or domain to block
- `is_domain` (required): boolean — Whether this entry blocks an entire domain

## GET /api/v2/background-jobs/{id}
_Get background job_  
Requires one of the following scopes: `background-jobs:read`, `background-jobs:all`, `all:read`, `all:all`

**Params**
- `data_fields` (query): string — Comma-separated list of fields to include from the `data` object (e.g., "success_count,failed_count" or "moved_lead_emails,moved_leads"). Fo
- `id` (path): string — The ID of the requested item

**200 response**
- `id` (required): string — Unique identifier for the background job
- `workspace_id` (required): string — Workspace ID
- `user_id`: null|string — The id of the user that triggered the action that created the job
- `type` (required): string enum=['move-leads', 'import-leads', 'export-leads', 'update-warmup-accounts', 'rename-variable', 'broadcast-ai-generate', 'broadcast-website-scrape', 'import-subscribers-from-crm', 'resync-subscriber-crm-tags', 'journey-ai-build'] — Type of background job
- `entity_id`: null|string — The id of the entity that the job is related to
- `entity_type`: string enum=['list', 'campaign', 'workspace', 'broadcast', 'subscriber-group-sync', 'subscriber-group', 'journey'] — Type of entity
- `data`: object — Data about the job, used to store any additional information we need to process the job
  - `moved_lead_emails`: array — For `move-leads` jobs, up to the first 10,000 email addresses of leads that actually moved or copied to the destination after all filters we...
    (array of)
- `progress` (required): number — Progress of the job as a percentage (from 0 to 100)
- `status` (required): string enum=['pending', 'in-progress', 'success', 'failed', 'draining', 'paused', 'cancelled'] — Job status
- `created_at` (required): string — Timestamp when the job was created
- `updated_at` (required): string — Timestamp when the job was last updated


---------------------------------------------------------------------------
## Extra details (verified from the full spec, 2026-10-20)

### campaign_schedule.schedules[] item
- `name`: string
- `timing`: `{ "from": "09:00", "to": "17:00" }` (HH:MM, 24h)
- `days`: `{ "0": bool, "1": bool, ... "6": bool }` — 0 = Sunday. minProperties 1.
- `timezone`: one of 102 enum values. **There is NO Asia/Riyadh or Asia/Qatar.**
  Gulf mapping: KSA / Qatar / Kuwait / Bahrain / Iraq -> `Asia/Baghdad` (UTC+3, no DST);
  Yemen -> `Asia/Aden`; UAE / Oman -> `Asia/Dubai` (UTC+4); Jordan -> `Asia/Amman`;
  Egypt -> `Africa/Cairo`; Lebanon -> `Asia/Beirut`; Pakistan -> `Asia/Karachi`; India -> `Asia/Kolkata`.
  Gulf work week: Sunday-Thursday => days {"0":true,"1":true,"2":true,"3":true,"4":true,"5":false,"6":false}.

### sequences[0].steps[].variants[] item
- `subject` (required): string — may contain `{{variables}}`; an EMPTY subject on step 2+ keeps the thread ("Re:").
- `body` (required): string — HTML. Use `<br/>` for line breaks. Variables: `{{firstName}}`, `{{companyName}}`,
  and any lead `custom_variables` key, e.g. `{{body_1}}`.
- `v_disabled`: boolean

### Variable values
Lead `custom_variables` values must be string|number|boolean|null (no objects/arrays). Put AI-written copy
in custom variables (subject_1, body_1, body_2, body_3) with `\n` converted to `<br/>`.

### Warmup analytics response (untyped in spec; observed shape — parse defensively)
`aggregate_data`: `{ "<email>": { sent, landed_inbox, landed_spam, received, health_score_label: "95%", health_score: 95 } }`
`email_date_data`: `{ "<email>": { "YYYY-MM-DD": { sent, landed_inbox, landed_spam, received } } }`

### Status enums
Account `status`: 1 active, 2 paused, 3 maintenance?, -1 connection error, -2 soft bounce error, -3 sending error.
Account `warmup_status`: 0 paused, 1 active, -1 banned, -2 spam folder unknown, -3 permanent suspension.
Lead `lt_interest_status`: 1 Interested, 2 Meeting booked, 3 Meeting completed, 4 Won, 0 Out of office,
-1 Not interested, -2 Wrong person, -3 Lost, -4 No show.
Campaign `status`: 0 draft, 1 active, 2 paused, 3 completed, 4 running subsequences, -99 suspended, -1 unhealthy, -2 bounce protect.
Rate limit: `GET /api/v2/emails` = 20 req/min. Others are higher but back off on 429.
