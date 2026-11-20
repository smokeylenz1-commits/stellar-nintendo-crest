################################################################################
# Secrets module – AWS Secrets Manager entries
#
# Credentials are created as empty placeholders; real values are populated via
# the secret rotation script (backend/scripts/rotate-secrets.ts) or through the
# AWS Console / CLI on first bootstrap.
################################################################################

resource "aws_secretsmanager_secret" "db" {
  name        = "ipredict/${var.environment}/db"
  description = "PostgreSQL credentials for iPredict ${var.environment}"

  recovery_window_in_days = 7

  tags = { Name = "ipredict-${var.environment}-db-secret" }
}

resource "aws_secretsmanager_secret_version" "db_placeholder" {
  secret_id = aws_secretsmanager_secret.db.id
  # Populated by rotate-secrets.ts; initial placeholder prevents plan drift.
  secret_string = jsonencode({
    username = "app_user_a"
    password = "ROTATE_ON_FIRST_DEPLOY"
    host     = ""
    port     = 5432
    dbname   = "ipredict"
  })

  lifecycle {
    # Prevent Terraform from overwriting credentials after the first rotation.
    ignore_changes = [secret_string]
  }
}

resource "aws_secretsmanager_secret" "relayer" {
  name        = "ipredict/${var.environment}/relayer"
  description = "Soroban relayer keypair for iPredict ${var.environment}"

  recovery_window_in_days = 7

  tags = { Name = "ipredict-${var.environment}-relayer-secret" }
}

resource "aws_secretsmanager_secret_version" "relayer_placeholder" {
  secret_id = aws_secretsmanager_secret.relayer.id
  secret_string = jsonencode({
    public_key  = "ROTATE_ON_FIRST_DEPLOY"
    secret_key  = "ROTATE_ON_FIRST_DEPLOY"
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}
