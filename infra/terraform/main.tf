################################################################################
# iPredict – Root Terraform configuration
#
# Provisions the full cloud stack:
#   • VPC with public/private subnets across two AZs
#   • RDS PostgreSQL 16 (Multi-AZ in production)
#   • ElastiCache Redis 7 cluster
#   • ECS Fargate cluster + services (backend, indexer, oracle)
#   • AWS Secrets Manager entries for DB credentials and relayer keys
#
# Usage:
#   terraform init
#   terraform workspace select staging|production
#   terraform plan -var-file=environments/<env>/terraform.tfvars
#   terraform apply -var-file=environments/<env>/terraform.tfvars
#   terraform destroy -var-file=environments/<env>/terraform.tfvars
################################################################################

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.50"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Remote state – update bucket/key/region to match your AWS account.
  backend "s3" {
    bucket         = "ipredict-tf-state"
    key            = "infra/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "ipredict-tf-locks"
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "iPredict"
      Environment = var.environment
      ManagedBy   = "Terraform"
    }
  }
}

###############################################################################
# Modules
###############################################################################

module "vpc" {
  source = "./modules/vpc"

  environment         = var.environment
  vpc_cidr            = var.vpc_cidr
  availability_zones  = var.availability_zones
  public_subnet_cidrs = var.public_subnet_cidrs
  private_subnet_cidrs = var.private_subnet_cidrs
}

module "secrets" {
  source = "./modules/secrets"

  environment = var.environment
}

module "rds" {
  source = "./modules/rds"

  environment          = var.environment
  vpc_id               = module.vpc.vpc_id
  private_subnet_ids   = module.vpc.private_subnet_ids
  db_instance_class    = var.db_instance_class
  db_allocated_storage = var.db_allocated_storage
  db_name              = var.db_name
  db_secret_arn        = module.secrets.db_secret_arn
  multi_az             = var.environment == "production"
  allowed_cidr_blocks  = [var.vpc_cidr]
}

module "redis" {
  source = "./modules/redis"

  environment        = var.environment
  vpc_id             = module.vpc.vpc_id
  private_subnet_ids = module.vpc.private_subnet_ids
  node_type          = var.redis_node_type
  num_cache_nodes    = var.redis_num_cache_nodes
  allowed_cidr_blocks = [var.vpc_cidr]
}

module "ecs" {
  source = "./modules/ecs"

  environment        = var.environment
  vpc_id             = module.vpc.vpc_id
  public_subnet_ids  = module.vpc.public_subnet_ids
  private_subnet_ids = module.vpc.private_subnet_ids
  db_secret_arn      = module.secrets.db_secret_arn
  relayer_secret_arn = module.secrets.relayer_secret_arn
  db_host            = module.rds.db_endpoint
  redis_host         = module.redis.redis_endpoint
  backend_image      = var.backend_image
  indexer_image      = var.indexer_image
  oracle_image       = var.oracle_image
  backend_cpu        = var.backend_cpu
  backend_memory     = var.backend_memory
}
