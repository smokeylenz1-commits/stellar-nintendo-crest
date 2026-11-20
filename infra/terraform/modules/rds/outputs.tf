output "db_endpoint" {
  description = "RDS instance endpoint."
  value       = aws_db_instance.postgres.endpoint
  sensitive   = true
}
