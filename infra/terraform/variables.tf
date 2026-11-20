################################################################################
# iPredict – Terraform variable definitions
################################################################################

variable "aws_region" {
  description = "AWS region for all resources."
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Deployment environment (staging | production)."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be 'staging' or 'production'."
  }
}

# ── Networking ──────────────────────────────────────────────────────────────

variable "vpc_cidr" {
  description = "CIDR block for the VPC."
  type        = string
  default     = "10.0.0.0/16"
}

variable "availability_zones" {
  description = "List of AZs to deploy subnets in (at least 2 for Multi-AZ RDS)."
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b"]
}

variable "public_subnet_cidrs" {
  description = "CIDR blocks for public subnets (one per AZ)."
  type        = list(string)
  default     = ["10.0.1.0/24", "10.0.2.0/24"]
}

variable "private_subnet_cidrs" {
  description = "CIDR blocks for private subnets (one per AZ)."
  type        = list(string)
  default     = ["10.0.11.0/24", "10.0.12.0/24"]
}

# ── RDS ─────────────────────────────────────────────────────────────────────

variable "db_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t3.medium"
}

variable "db_allocated_storage" {
  description = "Initial allocated storage for RDS in GiB."
  type        = number
  default     = 20
}

variable "db_name" {
  description = "Name of the application database."
  type        = string
  default     = "ipredict"
}

# ── ElastiCache ─────────────────────────────────────────────────────────────

variable "redis_node_type" {
  description = "ElastiCache node type."
  type        = string
  default     = "cache.t3.micro"
}

variable "redis_num_cache_nodes" {
  description = "Number of cache nodes in the ElastiCache cluster."
  type        = number
  default     = 1
}

# ── ECS / Container images ──────────────────────────────────────────────────

variable "backend_image" {
  description = "Docker image URI for the backend service."
  type        = string
}

variable "indexer_image" {
  description = "Docker image URI for the indexer service."
  type        = string
}

variable "oracle_image" {
  description = "Docker image URI for the oracle service."
  type        = string
}

variable "backend_cpu" {
  description = "ECS task CPU units (1 vCPU = 1024)."
  type        = number
  default     = 512
}

variable "backend_memory" {
  description = "ECS task memory in MiB."
  type        = number
  default     = 1024
}
