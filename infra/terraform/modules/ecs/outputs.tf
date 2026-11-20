output "cluster_name" {
  description = "Name of the ECS cluster."
  value       = aws_ecs_cluster.main.name
}

output "backend_service_name" {
  value = aws_ecs_service.backend.name
}

output "indexer_service_name" {
  value = aws_ecs_service.indexer.name
}

output "oracle_service_name" {
  value = aws_ecs_service.oracle.name
}
