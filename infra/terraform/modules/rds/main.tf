################################################################################
# RDS module – PostgreSQL 16, Multi-AZ in production
################################################################################

resource "aws_db_subnet_group" "main" {
  name       = "ipredict-${var.environment}-db-subnet-group"
  subnet_ids = var.private_subnet_ids

  tags = { Name = "ipredict-${var.environment}-db-subnet-group" }
}

resource "aws_security_group" "rds" {
  name        = "ipredict-${var.environment}-rds-sg"
  description = "Allow PostgreSQL traffic from within the VPC"
  vpc_id      = var.vpc_id

  ingress {
    description = "PostgreSQL from VPC"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = var.allowed_cidr_blocks
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "ipredict-${var.environment}-rds-sg" }
}

data "aws_secretsmanager_secret_version" "db" {
  secret_id = var.db_secret_arn
}

locals {
  db_creds = jsondecode(data.aws_secretsmanager_secret_version.db.secret_string)
}

resource "aws_db_instance" "postgres" {
  identifier        = "ipredict-${var.environment}-postgres"
  engine            = "postgres"
  engine_version    = "16"
  instance_class    = var.db_instance_class
  allocated_storage = var.db_allocated_storage
  storage_encrypted = true
  storage_type      = "gp3"

  db_name  = var.db_name
  username = local.db_creds.username
  password = local.db_creds.password

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false
  multi_az               = var.multi_az

  backup_retention_period = 7
  backup_window           = "02:00-03:00"
  maintenance_window      = "sun:04:00-sun:05:00"
  deletion_protection     = var.multi_az # enabled in production

  skip_final_snapshot       = !var.multi_az
  final_snapshot_identifier = var.multi_az ? "ipredict-${var.environment}-final" : null

  tags = { Name = "ipredict-${var.environment}-postgres" }
}
