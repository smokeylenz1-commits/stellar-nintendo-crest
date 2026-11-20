variable "environment"          { type = string }
variable "vpc_id"               { type = string }
variable "private_subnet_ids"   { type = list(string) }
variable "db_instance_class"    { type = string }
variable "db_allocated_storage" { type = number }
variable "db_name"              { type = string }
variable "db_secret_arn"        { type = string }
variable "multi_az"             { type = bool    default = false }
variable "allowed_cidr_blocks"  { type = list(string) }
