import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { getPool } from "../../config/db";
import { createErrorResponse } from "../utils";

interface EditQuestionRequest {
  question_id: string;
  description?: string;
  position?: number;
  question_type?: 'text' | 'long_text' | 'multiple_choice' | 'checkbox' | 'dropdown' | 'number' | 'date' | 'file' | 'radio' | 'description' | 'email' | 'phone' | 'radio_image';
  required?: boolean;
  image_urls?: string[];
  translations?: {
    translation_id: string;
    question_text: string;
  }[];
}

export async function editQuestion(req: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const body = await req.json() as EditQuestionRequest;

    if (!body.question_id) {
      return createErrorResponse(400, "question_id is required");
    }

    const pool = await getPool();

    // Build the question update query dynamically based on provided parameters
    let questionUpdateFields: string[] = [];
    let questionParams: { [key: string]: any } = {};

    if (body.description !== undefined) {
      questionUpdateFields.push("description = @description");
      questionParams["description"] = body.description;
    }

    if (body.position !== undefined) {
      questionUpdateFields.push("position = @position");
      questionParams["position"] = body.position;
    }

    if (body.question_type !== undefined) {
      questionUpdateFields.push("question_type = @question_type");
      questionParams["question_type"] = body.question_type;
    }

    if (body.required !== undefined) {
      questionUpdateFields.push("required = @required");
      questionParams["required"] = body.required;
    }

    if (body.image_urls !== undefined) {
      questionUpdateFields.push("image_urls = @image_urls");
      questionParams["image_urls"] = JSON.stringify(body.image_urls);
    }

    // Update question if any fields were provided
    if (questionUpdateFields.length > 0) {
      const questionQuery = `
        UPDATE questions
        SET ${questionUpdateFields.join(", ")}
        WHERE id = @question_id
      `;

      const questionRequest = pool.request();
      questionRequest.input("question_id", body.question_id);
      Object.entries(questionParams).forEach(([key, value]) => {
        questionRequest.input(key, value);
      });

      await questionRequest.query(questionQuery);
    }

    // Update translations if provided
    if (body.translations && body.translations.length > 0) {
      for (const translation of body.translations) {
        if (!translation.translation_id) {
          return createErrorResponse(400, "translation_id is required for each translation");
        }

        const translationQuery = `
          UPDATE question_translations
          SET question_text = @question_text
          WHERE id = @translation_id
        `;

        await pool.request()
          .input("translation_id", translation.translation_id)
          .input("question_text", translation.question_text)
          .query(translationQuery);
      }
    }

    return {
      status: 200,
      jsonBody: { message: "Question updated successfully" }
    };
  } catch (error) {
    context.log("Error updating question:", error);
    return createErrorResponse(500, "Internal Server Error: " + error.message);
  }
}

app.http("editQuestion", {
  methods: ["PUT"],
  authLevel: "anonymous",
  handler: editQuestion,
}); 