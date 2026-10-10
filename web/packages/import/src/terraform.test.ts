import { readFileSync } from 'node:fs';
import { simulate, validateDocument } from '@loadline/engine';
import type { LoadlineDocument, Preset } from '@loadline/model';
import { describe, expect, it } from 'vitest';
import { HclError, parseHcl } from './hcl.js';
import { detectSource, importConfigs } from './import.js';
import { SAMPLE_COMPOSE, SAMPLE_TERRAFORM } from './sample.js';

const repo = (path: string): string =>
  readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8');
const presets = (JSON.parse(repo('spec/presets/default.json')) as { presets: Preset[] }).presets;

function arrows(doc: LoadlineDocument): string[] {
  const label = new Map(doc.nodes.map((n) => [n.id, n.label]));
  const name = (port: string): string => label.get(port.slice(0, port.lastIndexOf(':')))!;
  return doc.edges
    .map((e) => `${name(e.from)} → ${name(e.to)}${e.only ? ` (${e.only})` : ''}`)
    .sort();
}

const tf = (...texts: string[]) =>
  importConfigs(texts.map((text, i) => ({ name: `main${i}.tf`, text })));

describe('parseHcl', () => {
  it('блоки, атрибуты, строки с ${}, heredoc и комментарии', () => {
    const body = parseHcl(`# комментарий
region = "eu-west-1" // и так
resource "aws_instance" "web" {
  ami   = "ami-\${var.v}" /* внутри */
  count = 2
  tags  = {
    Name = "web }" # скобка в строке
  }
  user_data = <<-EOF
    #!/bin/sh
    echo "}" > /tmp/x
  EOF
  lifecycle { create_before_destroy = true }
}
`);
    expect(body.attrs).toEqual({ region: '"eu-west-1"' });
    const web = body.blocks[0]!;
    expect(web).toMatchObject({ type: 'resource', labels: ['aws_instance', 'web'], line: 3 });
    expect(web.attrs['count']).toBe('2');
    expect(web.attrs['ami']).toBe('"ami-${var.v}"');
    expect(web.attrs['tags']).toContain('"web }"');
    expect(web.attrs['user_data']).toMatch(/^<<-EOF[\s\S]*EOF$/);
    expect(web.blocks[0]).toMatchObject({
      type: 'lifecycle',
      attrs: { create_before_destroy: 'true' },
    });
  });

  it('ошибки с номером строки', () => {
    const err = (src: string): HclError => {
      try {
        parseHcl(src);
      } catch (e) {
        return e as HclError;
      }
      throw new Error('ждали ошибку');
    };
    expect(err('resource "a" "b" {\n  x = 1\n').message).toMatch(/Блок не закрыт/);
    expect(err('a = "x\n').line).toBe(1);
    expect(err('x = [1, 2\n\ny = 3').message).toMatch(/Скобка/);
  });
});

describe('Terraform', () => {
  it('пример из окна импорта: CloudFront, ALB, ECS, Aurora с читателями, SQS → Lambda', () => {
    const { doc, services, notes } = tf(SAMPLE_TERRAFORM);
    expect(doc.meta.title).toBe('shop');
    expect(arrows(doc)).toEqual([
      'cdn → shop-alb',
      'cdn → shop-static',
      'shop-alb → shop-api',
      'shop-api → shop-cache (read)',
      'shop-api → shop-db (write)',
      'shop-api → shop-orders',
      'shop-cache → shop-db-ro',
      'shop-orders → shop-orders-lambda',
      'shop-orders-lambda → shop-db',
      'Клиенты → cdn',
    ]);
    const by = new Map(services.map((s) => [s.name, s]));
    expect(by.get('shop-api')).toMatchObject({ kind: 'service', replicas: 3 });
    expect(by.get('shop-db-ro')).toMatchObject({ kind: 'sql-replica', replicas: 2 });
    expect(by.get('shop-cache')).toMatchObject({ kind: 'cache', replicas: 2 });
    expect(by.get('shop-orders-lambda')).toMatchObject({ kind: 'worker' });
    expect(notes).toContain(
      'shop-api: автомасштабирование до 12 задач, на схеме 3 — модель сама не масштабируется',
    );

    expect(validateDocument(doc)).toEqual([]);
    const r = simulate(doc, { presets, samples: 2000 });
    expect(r.warnings).toEqual([]);
    expect(r.system.servedRps).toBeGreaterThan(0);
  });

  it('узнаётся по .tf и по блокам; с compose не смешивается', () => {
    expect(detectSource('main.tf', '')).toBe('terraform');
    expect(detectSource('prod.tfvars', 'replicas = 3')).toBe('terraform');
    expect(detectSource('pasted', 'resource "aws_s3_bucket" "b" {\n}\n')).toBe('terraform');
    expect(() =>
      importConfigs([
        { name: 'docker-compose.yml', text: SAMPLE_COMPOSE },
        { name: 'main.tf', text: SAMPLE_TERRAFORM },
      ]),
    ).toThrow(/что-то одно/);
    expect(() => tf('resource "aws_iam_role" "r" {\n  name = "x"\n}\n')).toThrow(
      /схему не из чего собрать/,
    );
  });

  it('ASG за ALB через autoscaling_attachment; count и tfvars сильнее default', () => {
    const main = `variable "web_count" {
  default = 2
}
resource "aws_lb" "front" {
  name = "front"
}
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.front.arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}
resource "aws_lb_target_group" "web" {
  port = 80
}
resource "aws_autoscaling_group" "web" {
  name             = "web"
  desired_capacity = var.web_count
}
resource "aws_autoscaling_attachment" "web" {
  autoscaling_group_name = aws_autoscaling_group.web.id
  lb_target_group_arn    = aws_lb_target_group.web.arn
}
resource "aws_instance" "batch" {
  count = 3
  tags  = { Name = "batch" }
}
`;
    const { doc, services } = tf(main, 'web_count = 5\n');
    expect(arrows(doc)).toEqual(['front → web', 'Клиенты → front']);
    expect(services.find((s) => s.name === 'web')?.replicas).toBe(5);
    expect(services.find((s) => s.name === 'batch')?.replicas).toBe(3);
  });

  it('модуль ECS: сервисы из карты services за модулем ALB, мощности ASG и выключенные модули пропущены', () => {
    const { doc, services } = tf(`module "ecs" {
  source       = "terraform-aws-modules/ecs/aws"
  cluster_name = "demo"
  capacity_providers = {
    ASG = {
      auto_scaling_group_provider = {
        auto_scaling_group_arn = module.asg.autoscaling_group_arn
      }
    }
  }
  services = {
    frontend = {
      desired_count = 2
      load_balancer = {
        service = {
          target_group_arn = module.alb.target_groups["frontend"].arn
        }
      }
      container_definitions = {
        app = {
          environment = [{ name = "API", value = "http://backend" }],
          secrets     = [{ name = "DB", valueFrom = module.db.db_instance_endpoint }]
        }
      }
    },
    "backend" = {
      container_definitions = {
        app = { environment = [{ name = "DB", value = module.db.db_instance_address }] }
      }
    }
  }
}
module "alb" {
  source = "terraform-aws-modules/alb/aws"
}
module "asg" {
  source = "terraform-aws-modules/autoscaling/aws"
}
module "db" {
  source = "terraform-aws-modules/rds/aws"
}
module "old" {
  source = "terraform-aws-modules/rds/aws"
  create = false
}
data "aws_sqs_queue" "external" {
  name = "legacy"
}
`);
    expect(arrows(doc)).toEqual([
      'alb → frontend',
      'backend → db',
      'frontend → db',
      'Клиенты → alb',
    ]);
    expect(services.find((s) => s.name === 'frontend')).toMatchObject({
      kind: 'service',
      replicas: 2,
      why: 'services модуля ecs',
    });
    expect(services.find((s) => s.name === 'asg')).toMatchObject({ kind: null, skipped: 'infra' });
    expect(services.map((s) => s.name)).not.toContain('old');
  });

  it('API Gateway → интеграция → Lambda; реплика RDS по replicate_source_db', () => {
    const { doc, services } = tf(`resource "aws_apigatewayv2_api" "http" {
  name          = "api"
  protocol_type = "HTTP"
}
resource "aws_apigatewayv2_integration" "fn" {
  api_id           = aws_apigatewayv2_api.http.id
  integration_type = "AWS_PROXY"
  integration_uri  = aws_lambda_function.handler.invoke_arn
}
resource "aws_lambda_function" "handler" {
  function_name = "handler"
  environment {
    variables = {
      WRITE = aws_db_instance.main.address
      READ  = aws_db_instance.replica.address
      TABLE = aws_dynamodb_table.sessions.name
    }
  }
}
resource "aws_db_instance" "main" {
  identifier = "app-db"
}
resource "aws_db_instance" "replica" {
  identifier          = "app-db-replica"
  replicate_source_db = aws_db_instance.main.identifier
}
resource "aws_dynamodb_table" "sessions" {
  name = "sessions"
}
`);
    expect(arrows(doc)).toEqual([
      'api → handler',
      'handler → app-db (write)',
      'handler → app-db-replica (read)',
      'handler → sessions',
      'Клиенты → api',
    ]);
    expect(services.find((s) => s.name === 'app-db-replica')?.kind).toBe('sql-replica');
  });
});
