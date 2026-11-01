resource "google_monitoring_notification_channel" "email" {
  count = var.alert_email == "" ? 0 : 1

  display_name = "JRA Bot 運用者"
  type         = "email"
  labels       = { email_address = var.alert_email }

  depends_on = [google_project_service.api]
}

locals {
  notification_channels = [for c in google_monitoring_notification_channel.email : c.id]
}

# Job の失敗（終了コード 1・2、75 を含む。DB 不達の 75 も通知: web CONTRACTS §9.1）
resource "google_monitoring_alert_policy" "job_failed" {
  display_name          = "JRA Bot: Cloud Run Job の失敗"
  combiner              = "OR"
  notification_channels = local.notification_channels

  conditions {
    display_name = "failed executions"
    condition_threshold {
      filter          = "metric.type=\"run.googleapis.com/job/completed_execution_count\" AND resource.type=\"cloud_run_job\" AND metric.labels.result=\"failed\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }

  depends_on = [google_project_service.api]
}

# Cloud SQL が起動中なのに運用モードが STOPPED の兆候は ops-status（定期）が検知して Discord に通知する（OPERATIONS_DESIGN §7）。
# ここでは Cloud SQL の長時間の高 CPU と、サービスの 5xx を見る。
resource "google_monitoring_alert_policy" "service_5xx" {
  display_name          = "JRA Bot: Cloud Run サービスの 5xx"
  combiner              = "OR"
  notification_channels = local.notification_channels

  conditions {
    display_name = "5xx responses"
    condition_threshold {
      filter          = "metric.type=\"run.googleapis.com/request_count\" AND resource.type=\"cloud_run_revision\" AND metric.labels.response_code_class=\"5xx\""
      comparison      = "COMPARISON_GT"
      threshold_value = 5
      duration        = "300s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }

  depends_on = [google_project_service.api]
}

# 予算アラート（請求アカウントが分かるときだけ。請求の権限は本人）
resource "google_billing_budget" "monthly" {
  count = var.billing_account_id == "" ? 0 : 1

  billing_account = var.billing_account_id
  display_name    = "JRA Bot 月額予算"

  budget_filter {
    projects = ["projects/${var.project_number}"]
  }
  amount {
    specified_amount {
      currency_code = "JPY"
      units         = tostring(var.monthly_budget_jpy)
    }
  }
  threshold_rules {
    threshold_percent = 0.5
  }
  threshold_rules {
    threshold_percent = 0.8
  }
  threshold_rules {
    threshold_percent = 1.0
  }
  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "FORECASTED_SPEND"
  }
}
