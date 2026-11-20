################################################################################
# ECS module – Fargate cluster + backend / indexer / oracle services
################################################################################

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.name
}

# ── IAM task execution role ──────────────────────────────────────────────────

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ecs_execution" {
  name               = "ipredict-${var.environment}-ecs-execution-role"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "ecs_execution_basic" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Allow tasks to pull secrets from Secrets Manager
resource "aws_iam_role_policy" "secrets_access" {
  name = "ipredict-${var.environment}-secrets-access"
  role = aws_iam_role.ecs_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = [var.db_secret_arn, var.relayer_secret_arn]
      }
    ]
  })
}

# ── CloudWatch log groups ────────────────────────────────────────────────────

resource "aws_cloudwatch_log_group" "services" {
  for_each          = toset(["backend", "indexer", "oracle"])
  name              = "/ecs/ipredict-${var.environment}-${each.key}"
  retention_in_days = 30
}

# ── ECS cluster ─────────────────────────────────────────────────────────────

resource "aws_ecs_cluster" "main" {
  name = "ipredict-${var.environment}"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = { Name = "ipredict-${var.environment}-cluster" }
}

# ── Security group for ECS tasks ────────────────────────────────────────────

resource "aws_security_group" "ecs_tasks" {
  name        = "ipredict-${var.environment}-ecs-tasks-sg"
  description = "ECS task ingress/egress"
  vpc_id      = var.vpc_id

  ingress {
    description = "HTTP from VPC"
    from_port   = 3001
    to_port     = 3001
    protocol    = "tcp"
    cidr_blocks = ["10.0.0.0/8"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "ipredict-${var.environment}-ecs-tasks-sg" }
}

# ── Task definition: backend ─────────────────────────────────────────────────

resource "aws_ecs_task_definition" "backend" {
  family                   = "ipredict-${var.environment}-backend"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.backend_cpu
  memory                   = var.backend_memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn

  container_definitions = jsonencode([
    {
      name  = "backend"
      image = var.backend_image
      portMappings = [{ containerPort = 3001 protocol = "tcp" }]
      environment = [
        { name = "NODE_ENV",    value = var.environment },
        { name = "DB_HOST",     value = var.db_host },
        { name = "REDIS_URL",   value = "redis://${var.redis_host}" },
      ]
      secrets = [
        { name = "DB_CREDENTIALS", valueFrom = var.db_secret_arn },
        { name = "RELAYER_KEYS",   valueFrom = var.relayer_secret_arn },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = "/ecs/ipredict-${var.environment}-backend"
          "awslogs-region"        = local.region
          "awslogs-stream-prefix" = "ecs"
        }
      }
    }
  ])
}

# ── Task definition: indexer ─────────────────────────────────────────────────

resource "aws_ecs_task_definition" "indexer" {
  family                   = "ipredict-${var.environment}-indexer"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.ecs_execution.arn

  container_definitions = jsonencode([
    {
      name  = "indexer"
      image = var.indexer_image
      environment = [
        { name = "NODE_ENV",  value = var.environment },
        { name = "DB_HOST",   value = var.db_host },
        { name = "REDIS_URL", value = "redis://${var.redis_host}" },
      ]
      secrets = [
        { name = "DB_CREDENTIALS", valueFrom = var.db_secret_arn },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = "/ecs/ipredict-${var.environment}-indexer"
          "awslogs-region"        = local.region
          "awslogs-stream-prefix" = "ecs"
        }
      }
    }
  ])
}

# ── Task definition: oracle ──────────────────────────────────────────────────

resource "aws_ecs_task_definition" "oracle" {
  family                   = "ipredict-${var.environment}-oracle"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.ecs_execution.arn

  container_definitions = jsonencode([
    {
      name  = "oracle"
      image = var.oracle_image
      environment = [
        { name = "NODE_ENV",  value = var.environment },
        { name = "DB_HOST",   value = var.db_host },
        { name = "REDIS_URL", value = "redis://${var.redis_host}" },
      ]
      secrets = [
        { name = "DB_CREDENTIALS", valueFrom = var.db_secret_arn },
        { name = "RELAYER_KEYS",   valueFrom = var.relayer_secret_arn },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = "/ecs/ipredict-${var.environment}-oracle"
          "awslogs-region"        = local.region
          "awslogs-stream-prefix" = "ecs"
        }
      }
    }
  ])
}

# ── ECS services ────────────────────────────────────────────────────────────

resource "aws_ecs_service" "backend" {
  name            = "ipredict-${var.environment}-backend"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.backend.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.ecs_tasks.id]
    assign_public_ip = false
  }

  lifecycle {
    ignore_changes = [desired_count]
  }
}

resource "aws_ecs_service" "indexer" {
  name            = "ipredict-${var.environment}-indexer"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.indexer.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.ecs_tasks.id]
    assign_public_ip = false
  }

  lifecycle {
    ignore_changes = [desired_count]
  }
}

resource "aws_ecs_service" "oracle" {
  name            = "ipredict-${var.environment}-oracle"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.oracle.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.ecs_tasks.id]
    assign_public_ip = false
  }

  lifecycle {
    ignore_changes = [desired_count]
  }
}
