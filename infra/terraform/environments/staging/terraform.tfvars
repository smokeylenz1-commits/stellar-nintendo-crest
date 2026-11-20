# iPredict – Staging environment variables
# Apply: terraform apply -var-file=environments/staging/terraform.tfvars

environment = "staging"
aws_region  = "us-east-1"

vpc_cidr             = "10.0.0.0/16"
availability_zones   = ["us-east-1a", "us-east-1b"]
public_subnet_cidrs  = ["10.0.1.0/24", "10.0.2.0/24"]
private_subnet_cidrs = ["10.0.11.0/24", "10.0.12.0/24"]

db_instance_class    = "db.t3.micro"
db_allocated_storage = 20
db_name              = "ipredict"

redis_node_type       = "cache.t3.micro"
redis_num_cache_nodes = 1

# Replace with actual ECR image URIs after first push
backend_image = "123456789012.dkr.ecr.us-east-1.amazonaws.com/ipredict-backend:latest"
indexer_image = "123456789012.dkr.ecr.us-east-1.amazonaws.com/ipredict-indexer:latest"
oracle_image  = "123456789012.dkr.ecr.us-east-1.amazonaws.com/ipredict-oracle:latest"

backend_cpu    = 256
backend_memory = 512
