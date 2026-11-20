variable "environment"         { type = string }
variable "vpc_id"              { type = string }
variable "public_subnet_ids"   { type = list(string) }
variable "private_subnet_ids"  { type = list(string) }
variable "db_secret_arn"       { type = string }
variable "relayer_secret_arn"  { type = string }
variable "db_host"             { type = string }
variable "redis_host"          { type = string }
variable "backend_image"       { type = string }
variable "indexer_image"       { type = string }
variable "oracle_image"        { type = string }
variable "backend_cpu"         { type = number default = 512 }
variable "backend_memory"      { type = number default = 1024 }
