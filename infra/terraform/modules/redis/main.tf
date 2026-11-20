################################################################################
# Redis module – ElastiCache Redis 7 cluster
################################################################################

resource "aws_elasticache_subnet_group" "main" {
  name       = "ipredict-${var.environment}-redis-subnet-group"
  subnet_ids = var.private_subnet_ids

  tags = { Name = "ipredict-${var.environment}-redis-subnet-group" }
}

resource "aws_security_group" "redis" {
  name        = "ipredict-${var.environment}-redis-sg"
  description = "Allow Redis traffic from within the VPC"
  vpc_id      = var.vpc_id

  ingress {
    description = "Redis from VPC"
    from_port   = 6379
    to_port     = 6379
    protocol    = "tcp"
    cidr_blocks = var.allowed_cidr_blocks
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "ipredict-${var.environment}-redis-sg" }
}

resource "aws_elasticache_cluster" "redis" {
  cluster_id           = "ipredict-${var.environment}-redis"
  engine               = "redis"
  engine_version       = "7.1"
  node_type            = var.node_type
  num_cache_nodes      = var.num_cache_nodes
  parameter_group_name = "default.redis7"
  port                 = 6379

  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [aws_security_group.redis.id]

  snapshot_retention_limit = 1
  snapshot_window          = "03:00-04:00"

  tags = { Name = "ipredict-${var.environment}-redis" }
}
